import type { MobileStatisticsResponse } from "@rai/api-contracts";

import { duration, heartRateZone, pace } from "../format.js";
import { useRemote } from "../hooks.js";
import { Card, IosLoading, Stat, zoneColor } from "./shared.js";

export function IosStatistics() {
  const result = useRemote<MobileStatisticsResponse>("/v1/mobile/statistics");
  if (!result.data) {
    return (
      <IosLoading error={result.error} onRetry={() => void result.reload()} />
    );
  }
  const data = result.data;
  const max = Math.max(
    ...data.months.map(
      (month) => month.runningDistanceKm + month.cyclingDistanceKm,
    ),
    1,
  );
  const change = data.totals.distanceChangeFraction;

  return (
    <>
      <Card title="月度跑量">
        <div className="ios-month-chart">
          {data.months.map((month) => {
            const stacked = month.runningDistanceKm + month.cyclingDistanceKm;
            const height = Math.max(10, (stacked / max) * 116);
            const runningShare =
              stacked > 0 ? (month.runningDistanceKm / stacked) * 100 : 0;
            const cyclingShare =
              stacked > 0 ? (month.cyclingDistanceKm / stacked) * 100 : 0;
            return (
              <div key={month.month}>
                <div className="ios-month-stack" style={{ height: `${height}px` }}>
                  <i
                    className="ios-month-cycling"
                    style={{ height: `${cyclingShare}%` }}
                  />
                  <i
                    className="ios-month-running"
                    style={{ height: `${runningShare}%` }}
                  />
                </div>
                <b>{stacked.toFixed(1)}</b>
                <small>{Number(month.month.slice(5))}月</small>
              </div>
            );
          })}
        </div>
        <div className="ios-legend">
          <span>
            <i className="ios-month-running" />
            跑步
          </span>
          <span>
            <i className="ios-month-cycling" />
            骑行
          </span>
        </div>
      </Card>
      <div className="ios-stat-grid">
        <Stat label="总跑量" value={`${data.totals.distanceKm.toFixed(1)} km`} />
        <Stat label="总时长" value={duration(data.totals.durationSeconds)} />
        <Stat label="训练次数" value={String(data.totals.workoutCount)} />
        <Stat
          label="平均配速"
          value={
            data.totals.averagePaceSecondsPerKm
              ? pace(data.totals.averagePaceSecondsPerKm)
              : "--"
          }
        />
        <Stat
          label="环比"
          value={
            change == null
              ? "数据不足"
              : `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`
          }
        />
      </div>
      <p className="ios-muted ios-caption">以上合计为近 28 天</p>
      <Card title="心率区间">
        <div className="ios-zone-list">
          {data.heartRateZones.map((zone) => (
            <div key={zone.zone}>
              <span>{heartRateZone(zone.zone)}</span>
              <i>
                <b
                  style={{
                    width: `${zone.fraction * 100}%`,
                    background: zoneColor(zone.zone),
                  }}
                />
              </i>
              <strong>{Math.round(zone.fraction * 100)}%</strong>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
