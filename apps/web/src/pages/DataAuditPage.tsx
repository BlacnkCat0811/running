import type { DataAuditResponse } from "@rai/api-contracts";
import { Link } from "react-router-dom";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, number } from "../format.js";
import { useRemote } from "../hooks.js";
import { ArrowLeft, CheckCircle, Database, Warning } from "../icons.js";

const percent = (value: number | null): string => value === null ? "--" : `${(value * 100).toFixed(1)}%`;

export function DataAuditPage() {
  const audit = useRemote<DataAuditResponse>("/v1/data-audit");
  if (audit.loading) return <LoadingBlock label="正在审计本地数据" />;
  if (audit.error || !audit.data) return <ErrorBlock message={audit.error ?? "无法读取数据审计"} onRetry={() => void audit.reload()} />;
  const data = audit.data;
  return (
    <div className="page audit-page">
      <Link to="/data" className="back-link"><ArrowLeft size={17} /> 返回数据与模型</Link>
      <header className="page-header split"><div><h1>数据审计</h1><p>检查导入覆盖、canonical 收敛、特征缺失和质量分布。</p></div><div className="model-chip"><span>Dataset</span><b>{data.datasetVersion?.slice(0, 20) ?? "--"}</b><small>{data.importCompletedAt ? date(data.importCompletedAt, true) : "--"}</small></div></header>

      <section className="audit-metrics"><article><span>健康记录</span><b>{data.canonical.healthRecords.toLocaleString("zh-CN")}</b><small>{data.ranges.healthRecords.first ? `${date(data.ranges.healthRecords.first)} — ${date(data.ranges.healthRecords.last ?? data.ranges.healthRecords.first)}` : "无时间范围"}</small></article><article><span>Workout 收敛</span><b>{data.canonical.workouts} → {data.canonical.canonicalWorkouts}</b><small>{data.canonical.workoutGroups} Group · {data.canonical.trainingSessions} Session</small></article><article><span>路线资产</span><b>{data.canonical.routes}</b><small>{data.canonical.routePoints.toLocaleString("zh-CN")} 个轨迹点</small></article><article><span>平均质量分</span><b>{number(data.featureQuality.averageQualityScore)}</b><small>平均心率覆盖 {percent(data.featureQuality.averageHeartRateCoverage)}</small></article></section>

      <section className="audit-grid"><article className="panel"><div className="panel-heading"><div><h2>训练来源与状态</h2><p>来源分类不展示设备原名。</p></div><Database size={20} /></div><div className="audit-groups"><div><h3>来源类别</h3>{data.sourceCategories.map((item) => <span key={item.category}><code>{item.category}</code><b>{item.count}</b></span>)}</div><div><h3>Session 状态</h3>{data.sessionStatuses.map((item) => <span key={item.status}><code>{item.status}</code><b>{item.count}</b></span>)}</div></div></article><article className="panel"><div className="panel-heading"><div><h2>心率覆盖范围</h2><p>缺失保持为 null，不补写 0 或中性分。</p></div></div><div className="coverage-range"><span><small>最低</small><b>{percent(data.featureQuality.minimumHeartRateCoverage)}</b></span><span><small>平均</small><b>{percent(data.featureQuality.averageHeartRateCoverage)}</b></span><span><small>最高</small><b>{percent(data.featureQuality.maximumHeartRateCoverage)}</b></span></div></article></section>

      <section className="audit-grid lower"><article className="panel"><div className="panel-heading"><div><h2>主要健康记录类型</h2><p>按数量倒序，最多显示 24 类。</p></div></div><div className="audit-list">{data.recordTypes.map((item) => <span key={item.type}><code>{item.type.replace("HKQuantityTypeIdentifier", "")}</code><b>{item.count.toLocaleString("zh-CN")}</b></span>)}</div></article><article className="panel"><div className="panel-heading"><div><h2>特征缺失原因</h2><p>来自 active Feature 的结构化缺失证据。</p></div></div>{data.missingReasons.length ? <div className="audit-list">{data.missingReasons.map((item) => <span key={item.reason}><code>{item.reason}</code><b>{item.count}</b></span>)}</div> : <div className="audit-empty"><CheckCircle size={24} /><p>当前 active Feature 没有结构化缺失原因。</p></div>}</article></section>

      <section className="panel audit-issues"><div className="panel-heading"><div><h2>导入质量问题</h2><p>按严重级别和代码聚合，不在页面暴露原始对象 ID。</p></div>{data.issues.length ? <Warning size={20} /> : <CheckCircle size={20} />}</div>{data.issues.length ? <div className="audit-list">{data.issues.map((item) => <span key={`${item.severity}:${item.code}`}><code>{item.severity} · {item.code}</code><b>{item.count}</b></span>)}</div> : <div className="audit-empty"><CheckCircle size={24} /><p>本次导入没有记录 canonical 或结构质量问题。</p></div>}</section>
    </div>
  );
}
