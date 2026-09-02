import type { MobileGoalsResponse, MobileStatisticsResponse, MobileTodayResponse, MobileTrendsResponse, WorkoutListResponse } from "@rai/api-contracts";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { useRemote } from "./hooks.js";
import { heartRateZone, sessionType } from "./format.js";
import { ArrowRight, ChartBar, ChartLine, CheckCircle, GearSix, Heartbeat, House, PersonSimpleRun, Target, TrendDown, TrendUp } from "./icons.js";

const tabs = [["/", "首页", House], ["/workouts", "训练", PersonSimpleRun], ["/statistics", "统计", ChartBar], ["/trends", "趋势", ChartLine], ["/settings", "设置", GearSix]] as const;

export function IosMobileApp() {
  const location = useLocation(); const navigate = useNavigate();
  const path = location.pathname.startsWith("/workouts") ? "/workouts" : location.pathname;
  const title = tabs.find(([to]) => to === path)?.[1] ?? "首页";
  return <div className="ios-mobile-app">
    <header className="ios-app-header"><div><span className="ios-app-brand">RAI</span><h1>{path === "/" ? "早上好，跑者" : title}</h1>{path === "/" ? <p>{formatToday(new Date())} · 保持今天的节奏</p> : null}</div><button className="ios-profile-button" aria-label="个人资料">跑</button></header>
    <main className="ios-mobile-content">{path === "/" ? <IosHome /> : null}{path === "/workouts" ? <IosWorkouts /> : null}{path === "/statistics" ? <IosStatistics /> : null}{path === "/trends" ? <IosTrends /> : null}{path === "/settings" ? <IosSettings /> : null}</main>
    <nav className="ios-mobile-tabbar" aria-label="iOS 应用导航">{tabs.map(([to, label, Icon]) => <button key={to} className={path === to ? "active" : ""} onClick={() => navigate(to)}><Icon size={22} weight={path === to ? "fill" : "regular"} /><span>{label}</span></button>)}</nav>
  </div>;
}

function Card({ title, action, children }: { title: string; action?: string; children: ReactNode }) { return <section className="ios-card"><div className="ios-card-title"><b>{title}</b>{action ? <span>{action}<ArrowRight size={14} /></span> : null}</div>{children}</section>; }

function IosHome() {
  const result = useRemote<MobileTodayResponse>("/v1/mobile/today");
  if (!result.data) return <IosLoading error={result.error} />;
  const d = result.data; const progress = Math.round((d.week.goalProgressFraction ?? 0) * 100); const max = Math.max(...d.weekDaily.map((item) => item.distanceKm), 1);
  return <>
    <div className="ios-freshness">{d.latestDataDate ? `数据截至 ${d.latestDataDate}` : "等待健康数据同步"}</div>
    <section className="ios-week-hero"><div className="ios-week-hero-copy"><span>本周跑量</span><strong>{d.week.distanceKm.toFixed(1)} <small>km</small></strong><p>目标完成度 {progress}%</p><div className="ios-hero-progress"><i style={{ width: `${progress}%` }} /></div><small className="ios-hero-footnote">距本周目标还差 {Math.max(0, (d.week.goalDistanceKm ?? 0) - d.week.distanceKm).toFixed(1)} km</small></div><div className="ios-hero-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div></section>
    <div className="ios-metric-grid"><MetricCard icon={<CheckCircle size={20} />} label="今日训练" value={`${d.today.distanceKm.toFixed(1)} km`} tone="mint" /><MetricCard icon={<Heartbeat size={20} />} label="平均配速" value={d.today.paceSecondsPerKm ? formatPace(d.today.paceSecondsPerKm) : "--"} tone="coral" /></div>
    <Card title="本周活动" action="查看详情"><div className="ios-week-chart">{d.weekDaily.map((item) => <div className="ios-week-column" key={item.localDate}><div className="ios-week-bar" style={{ height: `${Math.max(8, item.distanceKm / max * 84)}px` }} /><small>{weekDay(item.localDate)}</small></div>)}</div></Card>
    <Card title="最近训练" action="全部"><div className="ios-workout-list">{d.recentWorkouts.length ? d.recentWorkouts.map((workout) => <WorkoutRow key={workout.id} workout={workout} />) : <EmptyState label="还没有训练记录" />}</div></Card>
  </>;
}

function MetricCard({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: "mint" | "coral" }) { return <section className={`ios-metric-card ${tone}`}><span className="ios-metric-icon">{icon}</span><small>{label}</small><strong>{value}</strong></section>; }
function IosWorkouts() { const result = useRemote<WorkoutListResponse>("/v1/workouts?limit=30"); if (!result.data) return <IosLoading error={result.error} />; return <Card title="全部训练"><div className="ios-workout-list">{result.data.items.length ? result.data.items.map((workout) => <WorkoutRow key={workout.id} workout={workout} detailed />) : <EmptyState label="还没有训练记录" />}</div></Card>; }
function WorkoutRow({ workout, detailed = false }: { workout: WorkoutListResponse["items"][number]; detailed?: boolean }) { return <div className="ios-workout-row"><span className="ios-workout-icon"><PersonSimpleRun size={19} /></span><span className="ios-workout-copy"><b>{sessionType(workout.sessionType || "unknown")}</b><small>{formatWorkoutDate(workout.startedAt)}{detailed && workout.averageHeartRateBpm ? ` · ${Math.round(workout.averageHeartRateBpm)} 次/分` : ""}</small></span><strong>{workout.distanceKm == null ? "--" : workout.distanceKm.toFixed(1)} <small>km</small></strong></div>; }

function IosStatistics() { const result = useRemote<MobileStatisticsResponse>("/v1/mobile/statistics"); if (!result.data) return <IosLoading error={result.error} />; const d = result.data; const max = Math.max(...d.months.map((month) => month.totalDistanceKm), 1); return <><Card title="月度跑量"><div className="ios-month-chart">{d.months.map((month) => <div key={month.month}><div className="ios-month-bar" style={{ height: `${Math.max(10, month.totalDistanceKm / max * 116)}px` }} /><b>{month.totalDistanceKm.toFixed(1)}</b><small>{month.month.slice(5)}月</small></div>)}</div></Card><div className="ios-stat-grid"><Stat label="总跑量" value={`${d.totals.distanceKm.toFixed(1)} km`} /><Stat label="总时长" value={formatDuration(d.totals.durationSeconds)} /><Stat label="训练次数" value={String(d.totals.workoutCount)} /><Stat label="平均配速" value={d.totals.averagePaceSecondsPerKm ? formatPace(d.totals.averagePaceSecondsPerKm) : "--"} /></div><Card title="心率区间"><div className="ios-zone-list">{d.heartRateZones.map((zone) => <div key={zone.zone}><span>{heartRateZone(zone.zone)}</span><i><b style={{ width: `${zone.fraction * 100}%` }} /></i><strong>{Math.round(zone.fraction * 100)}%</strong></div>)}</div></Card></>; }
function IosTrends() { const result = useRemote<MobileTrendsResponse>("/v1/mobile/trends"); if (!result.data) return <IosLoading error={result.error} />; const d = result.data; const max = Math.max(...d.weeks.map((week) => week.distanceKm), 1); const change = d.distanceChangeFraction4Weeks; return <><Card title="周跑量趋势" action="12 周"><div className="ios-trend-summary"><strong>{change === null ? "数据不足" : `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`}</strong><small>较 4 周前</small></div><div className="ios-trend-chart">{d.weeks.map((week) => <i key={week.periodStart} style={{ height: `${Math.max(5, week.distanceKm / max * 104)}px` }} />)}</div></Card>{d.insights.map((insight) => <div className={`ios-insight ${insight.kind}`} key={insight.title}>{insight.kind === "positive" ? <TrendUp size={19} /> : <TrendDown size={19} />}<span><b>{insight.title}</b><small>{insight.detail}</small></span></div>)}<Card title="个人纪录"><Record label="5 公里最快" value={d.records.fastest5k ? formatPace(d.records.fastest5k.paceSecondsPerKm) : "--"} /><Record label="10 公里最快" value={d.records.fastest10k ? formatPace(d.records.fastest10k.paceSecondsPerKm) : "--"} /><Record label="单次最长距离" value={d.records.longestDistance ? `${d.records.longestDistance.distanceKm.toFixed(1)} km` : "--"} /><Record label="月最大跑量" value={d.records.biggestMonth ? `${d.records.biggestMonth.distanceKm.toFixed(1)} km` : "--"} /></Card></>; }

function IosSettings() { const goals = useRemote<MobileGoalsResponse>("/v1/mobile/goals"); const [value, setValue] = useState(""); const [saved, setSaved] = useState(false); useEffect(() => { if (goals.data) setValue(String(goals.data.weeklyDistanceKm)); }, [goals.data]); async function saveGoal() { await api("/v1/mobile/goals", { method: "PUT", body: JSON.stringify({ weeklyDistanceKm: Number(value) }) }); setSaved(true); window.setTimeout(() => setSaved(false), 1800); } return <><Card title="服务器连接"><div className="ios-setting-row"><Heartbeat size={20} /><span>API 服务</span><b className="ios-online">已连接</b></div><small className="ios-setting-note">数据存储在当前 RAI 后端服务器</small></Card><Card title="周目标"><label className="ios-input-label" htmlFor="ios-weekly-goal">每周跑量（km）</label><input id="ios-weekly-goal" className="ios-input" value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" /><button className="ios-save" onClick={() => void saveGoal()}>{saved ? "已保存" : "保存目标"}</button></Card><Card title="关于 RAI"><p className="ios-muted">Running Intelligence · 本地优先的跑步能力分析。</p></Card></>; }

function Stat({ label, value }: { label: string; value: string }) { return <div className="ios-stat"><small>{label}</small><b>{value}</b></div>; }
function Record({ label, value }: { label: string; value: string }) { return <div className="ios-record"><span>{label}</span><b>{value}</b></div>; }
function EmptyState({ label }: { label: string }) { return <div className="ios-empty-state"><Target size={23} /><span>{label}</span></div>; }
function IosLoading({ error }: { error: string | null }) { return <div className="ios-loading">{error ?? "正在读取数据…"}</div>; }
function formatDuration(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.round(seconds % 3600 / 60); return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`; }
function formatPace(seconds: number) { return `${Math.floor(seconds / 60)}'${String(Math.round(seconds % 60)).padStart(2, "0")}"`; }
function formatToday(date: Date) { return date.toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" }); }
function formatWorkoutDate(value: string) { return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); }
function weekDay(value: string) { return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", { weekday: "short" }); }
