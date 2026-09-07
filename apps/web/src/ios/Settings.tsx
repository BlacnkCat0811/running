import type { MobileGoalsResponse, MobileRaceDistance } from "@rai/api-contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { notifyDataUpdated } from "../events.js";
import { date } from "../format.js";
import { useRemote } from "../hooks.js";
import { Heartbeat } from "../icons.js";
import { hasNativeBridge, postNative, useNativeStatus } from "./native.js";
import { Card, IosLoading } from "./shared.js";

export function IosSettings() {
  const goals = useRemote<MobileGoalsResponse>("/v1/mobile/goals");
  const native = useNativeStatus();
  const [value, setValue] = useState("");
  const [easyFloor, setEasyFloor] = useState("70");
  const [qualityCap, setQualityCap] = useState("2");
  const [raceDate, setRaceDate] = useState("");
  const [raceDistance, setRaceDistance] = useState<MobileRaceDistance | "">("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nativeBridge = hasNativeBridge();

  const weeklyGoal = goals.data?.weeklyDistanceKm;
  const easyFloorValue = goals.data?.easyDurationFloorFraction;
  const qualityCapValue = goals.data?.qualitySessionCap;
  const raceDateValue = goals.data?.raceTarget?.date ?? "";
  const raceDistanceValue = goals.data?.raceTarget?.distance ?? "";
  useEffect(() => {
    if (weeklyGoal != null) setValue(String(weeklyGoal));
  }, [weeklyGoal]);
  useEffect(() => {
    if (easyFloorValue != null) setEasyFloor(String(Math.round(easyFloorValue * 100)));
  }, [easyFloorValue]);
  useEffect(() => {
    if (qualityCapValue != null) setQualityCap(String(qualityCapValue));
  }, [qualityCapValue]);
  useEffect(() => {
    setRaceDate(raceDateValue);
    setRaceDistance(raceDistanceValue);
  }, [raceDateValue, raceDistanceValue]);

  async function saveGoal() {
    const weeklyDistanceKm = Number(value);
    if (!Number.isFinite(weeklyDistanceKm) || weeklyDistanceKm < 1 || weeklyDistanceKm > 500) {
      setError("请输入 1–500 的周跑量（公里）");
      setSaved(false);
      return;
    }
    const floor = Number(easyFloor) / 100;
    if (!Number.isFinite(floor) || floor < 0.4 || floor > 0.95) {
      setError("轻松时长占比请填 40–95");
      return;
    }
    const cap = Number(qualityCap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 4) {
      setError("质量课上限请填 0–4");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api<MobileGoalsResponse>("/v1/mobile/goals", {
        method: "PUT",
        body: JSON.stringify({
          weeklyDistanceKm,
          expectedRevision: goals.data?.revision,
          easyDurationFloorFraction: floor,
          qualitySessionCap: cap,
          raceTarget: raceDate && raceDistance
            ? { date: raceDate, distance: raceDistance, targetPaceSecondsPerKm: null }
            : null,
        }),
      });
      setValue(String(next.weeklyDistanceKm));
      setSaved(true);
      notifyDataUpdated();
      window.setTimeout(() => setSaved(false), 1800);
    } catch (caught) {
      setSaved(false);
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card title="服务器连接">
        <div className="ios-setting-row">
          <Heartbeat size={20} />
          <span>API 服务</span>
          <b className={native.reachable ? "ios-online" : "ios-offline"}>
            {native.reachable ? "已连接" : "未连接"}
          </b>
        </div>
        {nativeBridge ? (
          <button
            type="button"
            className="ios-save"
            onClick={() => postNative({ action: "openServer" })}
          >
            服务器设置
          </button>
        ) : null}
        <small className="ios-setting-note">
          数据保存在已连接的 RAI 服务。离线时可以查看已加载内容，新的同步和修改需要联网。
        </small>
      </Card>
      <Card title="健康数据">
        {nativeBridge ? (
          <>
            <button
              type="button"
              className="ios-save"
              disabled={native.isBusy}
              onClick={() => postNative({ action: "syncHealth", full: false })}
            >
              同步健康
            </button>
            <button
              type="button"
              className="ios-save ios-save-secondary"
              disabled={native.isBusy}
              onClick={() => postNative({ action: "syncHealth", full: true })}
            >
              重新导入全部
            </button>
            <button
              type="button"
              className="ios-save ios-save-secondary"
              onClick={() => postNative({ action: "openHealthSettings" })}
            >
              打开健康权限
            </button>
          </>
        ) : null}
        <small className="ios-setting-note">
          {native.lastSyncAt
            ? `上次同步 ${date(native.lastSyncAt, true)}`
            : "尚未同步"}
          {native.lastWorkoutCount != null
            ? ` · ${native.lastWorkoutCount} 次训练`
            : ""}
        </small>
        {native.lastSyncError ? (
          <p className="ios-sync-error">{native.lastSyncError}</p>
        ) : native.lastSyncMessage ? (
          <p className="ios-setting-note">{native.lastSyncMessage}</p>
        ) : null}
      </Card>
      <Card title="周目标">
        {!goals.data && (goals.loading || goals.error) ? (
          <IosLoading error={goals.error} onRetry={() => void goals.reload()} />
        ) : (
          <>
            <label className="ios-input-label" htmlFor="ios-weekly-goal">
              每周跑量（km）
            </label>
            <input
              id="ios-weekly-goal"
              className="ios-input"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              inputMode="decimal"
            />
            {error ? <p className="ios-sync-error">{error}</p> : null}
            <label className="ios-input-label" htmlFor="ios-easy-floor">
              轻松时长下限（%）
            </label>
            <input
              id="ios-easy-floor"
              className="ios-input"
              value={easyFloor}
              onChange={(event) => setEasyFloor(event.target.value)}
              inputMode="numeric"
            />
            <label className="ios-input-label" htmlFor="ios-quality-cap">
              每周质量课上限
            </label>
            <input
              id="ios-quality-cap"
              className="ios-input"
              value={qualityCap}
              onChange={(event) => setQualityCap(event.target.value)}
              inputMode="numeric"
            />
            <label className="ios-input-label" htmlFor="ios-race-date">
              目标赛事日期
            </label>
            <input
              id="ios-race-date"
              className="ios-input"
              type="date"
              value={raceDate}
              onChange={(event) => setRaceDate(event.target.value)}
            />
            <label className="ios-input-label" htmlFor="ios-race-distance">
              目标距离
            </label>
            <select
              id="ios-race-distance"
              className="ios-input"
              value={raceDistance}
              onChange={(event) => setRaceDistance(event.target.value as MobileRaceDistance | "")}
            >
              <option value="">不设置</option>
              <option value="five_k">5 公里</option>
              <option value="ten_k">10 公里</option>
              <option value="half_marathon">半程马拉松</option>
            </select>
            <button
              type="button"
              className="ios-save"
              disabled={saving}
              onClick={() => void saveGoal()}
            >
              {saved ? "已保存" : "保存目标"}
            </button>
          </>
        )}
      </Card>
      <Card title="关于 RAI">
        <p className="ios-muted">
          Running Intelligence · 本地优先的跑步能力分析。
        </p>
      </Card>
    </>
  );
}
