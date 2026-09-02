import type { MobileGoalsResponse, MobileStatisticsResponse, MobileTodayResponse, MobileTrendsResponse, WorkoutListResponse } from "@rai/api-contracts";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useRemote } from "./hooks.js";
import { api } from "./api.js";
import { ChartBar, ChartLine, GearSix, House, PersonSimpleRun, Timer, ArrowRight, Heartbeat } from "./icons.js";

const tabs = [
  ["/", "首页", House], ["/workouts", "训练", PersonSimpleRun], ["/statistics", "统计", ChartBar], ["/trends", "趋势", ChartLine], ["/settings", "设置", GearSix]
] as const;

export function IosMobileApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.startsWith("/workouts") ? "/workouts" : location.pathname;
  const title = tabs.find(([to]) => to === path)?.[1] ?? "首页";
  return <div className="ios-mobile-app">
    <header className="ios-mobile-header"><div><span className="ios-mobile-kicker">RAI · RUNNING INTELLIGENCE</span><h1>{title}</h1></div><span className="ios-mobile-avatar">跑</span></header>
    <main className="ios-mobile-content">{path === "/" ? <IosHome /> : path === "/workouts" ? <IosWorkouts /> : path === "/statistics" ? <IosStatistics /> : path === "/trends" ? <IosTrends /> : <IosSettings />}</main>
    <nav className="ios-mobile-tabbar">{tabs.map(([to, label, Icon]) => <button key={to} className={path === to ? "active" : ""} onClick={() => navigate(to)}><Icon size={21} weight={path === to ? "fill" : "regular"} /><span>{label}</span></button>)}</nav>
  </div>;
}

function Card({ title, action, children, className = "" }: { title: string; action?: string; children: ReactNode; className?: string }) {
  return <section className={`ios-card ${className}`}><div className="ios-card-title"><b>{title}</b>{action ? <span>{action} <ArrowRight size={12} /></span> : null}</div>{children}</section>;
}

function IosHome() {
  const today = useRemote<MobileTodayResponse>("/v1/mobile/today");
  if (!today.data) return <IosLoading error={today.error} />;
  const d = today.data;
  const max = Math.max(...d.weekDaily.map((x) => x.distanceKm), 1);
  return <>
    {d.latestDataDate ? <div className="ios-freshness">数据截至 {d.latestDataDate}</div> : null}
    <section className="ios-today-card"><div className="ios-today-label">今日跑量</div><strong>{d.today.distanceKm.toFixed(1)}<small> km</small></strong><div className="ios-today-metrics"><span><b>{formatDuration(d.today.durationSeconds)}</b><small>时长</small></span><span><b>{d.today.paceSecondsPerKm ? formatPace(d.today.paceSecondsPerKm) : "--"}</b><small>配速</small></span><span><b>{d.today.energyKcal ? Math.round(d.today.energyKcal) : "--"}</b><small>卡路里</small></span></div><i className="ios-pixel-runner" /></section>
    <Card title="本周目标" action="详情"><div className="ios-goal-row"><div className="ios-ring"><span>{Math.round((d.week.goalProgressFraction ?? 0) * 100)}%</span></div><div className="ios-goal-copy"><b>{d.week.distanceKm.toFixed(1)} / {d.week.goalDistanceKm?.toFixed(0) ?? "--"} km</b><small>{d.week.workoutCount} 次训练 · 目标进度</small><div className="ios-progress"><i style={{ width: `${Math.min(100, (d.week.goalProgressFraction ?? 0) * 100)}%` }} /></div></div></div></Card>
    <Card title="本周跑量"><div className="ios-week-chart">{d.weekDaily.map((x) => <div className="ios-week-col" key={x.localDate}><div className="ios-week-bar" style={{ height: `${Math.max(4, x.distanceKm / max * 76)}px` }} /><small>{x.localDate.slice(5).replace("-", "/")}</small></div>)}</div></Card>
    <Card title="最近训练" action="全部"><div className="ios-workout-list">{d.recentWorkouts.slice(0, 5).map((w) => <div className="ios-workout-row" key={w.id}><span className="ios-workout-icon"><PersonSimpleRun size={18} /></span><span><b>跑步</b><small>{new Date(w.startedAt).toLocaleDateString("zh-CN")}</small></span><strong>{w.distanceKm?.toFixed(1) ?? "--"}<small> km</small></strong></div>)}</div></Card>
  </>;
}

function IosWorkouts() {
  const result = useRemote<WorkoutListResponse>("/v1/workouts?limit=30");
  if (!result.data) return <IosLoading error={result.error} />;
  return <Card title="全部训练"><div className="ios-workout-list">{result.data.items.map((w) => <div className="ios-workout-row" key={w.id}><span className="ios-workout-icon"><PersonSimpleRun size={18} /></span><span><b>跑步</b><small>{new Date(w.startedAt).toLocaleString("zh-CN")}</small></span><strong>{w.distanceKm?.toFixed(1) ?? "--"}<small> km</small></strong></div>)}</div></Card>;
}

function IosStatistics() {
  const result = useRemote<MobileStatisticsResponse>("/v1/mobile/statistics");
  if (!result.data) return <IosLoading error={result.error} />;
  const d = result.data; const max = Math.max(...d.months.map((x) => x.totalDistanceKm), 1);
  return <><Card title="月度跑量"><div className="ios-month-chart">{d.months.map((m) => <div key={m.month}><div className="ios-month-bar" style={{ height: `${Math.max(6, m.totalDistanceKm / max * 112)}px` }} /><b>{m.totalDistanceKm.toFixed(1)}</b><small>{m.month.slice(5)}月</small></div>)}</div></Card><div className="ios-stat-grid"><Stat label="总跑量" value={`${d.totals.distanceKm.toFixed(1)} km`} /><Stat label="总时长" value={formatDuration(d.totals.durationSeconds)} /><Stat label="训练次数" value={String(d.totals.workoutCount)} /><Stat label="平均配速" value={d.totals.averagePaceSecondsPerKm ? formatPace(d.totals.averagePaceSecondsPerKm) : "--"} /></div><Card title="心率区间"><div className="ios-zone-list">{d.heartRateZones.map((z) => <div key={z.zone}><span>{z.zone}</span><i><b style={{ width: `${z.fraction * 100}%` }} /></i><strong>{Math.round(z.fraction * 100)}%</strong></div>)}</div></Card></>;
}

function IosTrends() {
  const result = useRemote<MobileTrendsResponse>("/v1/mobile/trends");
  if (!result.data) return <IosLoading error={result.error} />;
  const d = result.data; const max = Math.max(...d.weeks.map((x) => x.distanceKm), 1);
  return <><Card title="周跑量趋势" action="12 周"><div className="ios-trend-stat">{d.distanceChangeFraction4Weeks === null ? "数据不足" : `${d.distanceChangeFraction4Weeks >= 0 ? "+" : ""}${Math.round(d.distanceChangeFraction4Weeks * 100)}%`}<small>较 4 周前</small></div><div className="ios-trend-chart">{d.weeks.map((w) => <i key={w.periodStart} style={{ height: `${Math.max(3, w.distanceKm / max * 100)}px` }} />)}</div></Card>{d.insights.map((x) => <div className={`ios-insight ${x.kind}`} key={x.title}><b>{x.title}</b><span>{x.detail}</span></div>)}<Card title="个人纪录"><Record label="5 公里最快" value={d.records.fastest5k ? formatPace(d.records.fastest5k.paceSecondsPerKm) : "--"} /><Record label="10 公里最快" value={d.records.fastest10k ? formatPace(d.records.fastest10k.paceSecondsPerKm) : "--"} /><Record label="单次最长距离" value={d.records.longestDistance ? `${d.records.longestDistance.distanceKm.toFixed(1)} km` : "--"} /><Record label="月最大跑量" value={d.records.biggestMonth ? `${d.records.biggestMonth.distanceKm.toFixed(1)} km` : "--"} /></Card></>;
}

function IosSettings() {
  const goals = useRemote<MobileGoalsResponse>("/v1/mobile/goals");
  const [value, setValue] = useState("");
  useEffect(() => { if (goals.data) setValue(String(goals.data.weeklyDistanceKm)); }, [goals.data]);
  return <><Card title="服务器连接"><div className="ios-setting-row"><Heartbeat size={19} /><span>API 服务</span><b className="ios-online">已连接</b></div><small className="ios-setting-note">数据存储在当前 RAI 后端服务器</small></Card><Card title="周目标"><label className="ios-input-label">每周跑量（km）</label><input className="ios-input" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" /><button className="ios-save" onClick={() => api("/v1/mobile/goals", { method: "PUT", body: JSON.stringify({ weeklyDistanceKm: Number(value) }) })}>保存目标</button></Card><Card title="关于 RAI"><p className="ios-muted">Running Intelligence · 本地优先的跑步能力分析。</p></Card></>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="ios-stat"><small>{label}</small><b>{value}</b></div>; }
function Record({ label, value }: { label: string; value: string }) { return <div className="ios-record"><span>{label}</span><b>{value}</b></div>; }
function IosLoading({ error }: { error: string | null }) { return <div className="ios-loading">{error ?? "正在读取数据…"}</div>; }
function formatDuration(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.round(seconds % 3600 / 60); return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`; }
function formatPace(seconds: number) { return `${Math.floor(seconds / 60)}'${String(Math.round(seconds % 60)).padStart(2, "0")}"`; }
