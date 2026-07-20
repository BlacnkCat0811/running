import "../pixel-layout.css";
import "../data-reference.css";
import type { DataAuditResponse } from "@rai/api-contracts";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";

import { ErrorBlock, LoadingBlock } from "../components/Feedback.js";
import { date, number } from "../format.js";
import { useRemote } from "../hooks.js";
import { CheckCircle, Database, Heartbeat, PersonSimpleRun, ShieldCheck, Timer, Warning } from "../icons.js";

const percent = (value: number | null): string => value === null ? "--" : `${(value * 100).toFixed(1)}%`;
const share = (value: number, total: number): string => total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";

export function DataAuditPage() {
  const audit = useRemote<DataAuditResponse>("/v1/data-audit");
  if (audit.loading) return <LoadingBlock label="正在审计本地数据" />;
  if (audit.error || !audit.data) return <ErrorBlock message={audit.error ?? "无法读取数据审计"} onRetry={() => void audit.reload()} />;
  const data = audit.data;
  const totalIssues = data.issues.reduce((sum, item) => sum + item.count, 0);
  const topRecords = data.recordTypes.slice(0, 6);
  const topMissing = data.missingReasons.slice(0, 5);
  const sourceCategoryTotal = data.sourceCategories.reduce((sum, item) => sum + item.count, 0);
  const qualityScore = percent(data.featureQuality.averageQualityScore);
  const heartMin = percent(data.featureQuality.minimumHeartRateCoverage);
  const heartAvg = percent(data.featureQuality.averageHeartRateCoverage);
  const heartMax = percent(data.featureQuality.maximumHeartRateCoverage);

  return (
    <div className="page audit-page data-reference-page">
      <header className="page-header audit-reference-header">
        <Database size={48} />
        <h1>数据审计</h1>
        <span className="audit-dataset-tag">Dataset</span>
      </header>
      <div className="audit-source-strip">
        <span>当前 Dataset：{data.datasetVersion ?? "Apple Health 运动与健康数据"}</span>
        <span>来源：Apple Health 导出</span>
        <span>文件：export.xml</span>
        <span>导入时间：{data.importCompletedAt ? date(data.importCompletedAt, true) : "--"}</span>
      </div>

      <section className="audit-overview" aria-label="审计概览">
        <article><Database size={43} /><span><small>总记录条数</small><b>{data.canonical.healthRecords.toLocaleString("zh-CN")}</b><em>/ 健康记录</em></span></article>
        <article><PersonSimpleRun size={43} /><span><small>运动次数</small><b>{data.canonical.trainingSessions.toLocaleString("zh-CN")}</b><em>条</em></span></article>
        <article><Timer size={43} /><span><small>训练资产</small><b>{data.canonical.workouts.toLocaleString("zh-CN")}</b><em>Workout</em></span></article>
        <article><Heartbeat size={43} /><span><small>平均质量分</small><b className="cyan">{qualityScore}</b><em>心率覆盖 {heartAvg}</em></span></article>
        <article><Warning size={43} /><span><small>待处理问题</small><b className="coral">{totalIssues}</b><em>{data.issues.length} 类</em></span></article>
      </section>

      <div className="audit-reference-grid">
        <section className="audit-reference-panel source-panel">
          <h2>训练来源与状态</h2>
          <div className="audit-table audit-source-table">
            <div className="audit-tr head"><span>来源</span><span>记录条数</span><span>占比</span><span>状态分布</span></div>
            {data.sourceCategories.slice(0, 5).map((item, index) => <div className="audit-tr" key={item.category}><span><i>{["♥", "▣", "▥", "☁", "✚"][index] ?? "●"}</i>{item.category}</span><span>{item.count.toLocaleString("zh-CN")}</span><span>{share(item.count, sourceCategoryTotal)}</span><span><b className="mini-bar" style={{ "--bar": `${Math.max(5, (item.count / Math.max(1, sourceCategoryTotal)) * 100)}%` } as CSSProperties} /></span></div>)}
            <div className="audit-tr total"><span>合计</span><span>{sourceCategoryTotal.toLocaleString("zh-CN")}</span><span>{sourceCategoryTotal ? "100%" : "0.0%"}</span><span>{data.canonical.workouts.toLocaleString("zh-CN")} Workouts</span></div>
          </div>
        </section>

        <section className="audit-reference-panel coverage-panel">
          <h2>心率覆盖范围</h2>
          <div className="coverage-values"><span><small>最低</small><b>{heartMin}</b></span><span><small>平均</small><b>{heartAvg}</b></span><span><small>最高</small><b>{heartMax}</b></span></div>
          <div className="coverage-ruler"><i /><i /><i /><b /></div>
          <div className="coverage-legend"><span>■ 最低覆盖</span><span>■ 平均覆盖</span><span>■ 最高覆盖</span></div>
        </section>

        <section className="audit-reference-panel record-panel">
          <h2>主要健康记录类型</h2>
          <div className="audit-table"><div className="audit-tr head"><span>#　类型</span><span>记录条数</span><span>占比</span><span>统计范围</span></div>{topRecords.map((item, index) => <div className="audit-tr" key={item.type}><span>{index + 1}　{item.type.replace("HKQuantityTypeIdentifier", "")}</span><span>{item.count.toLocaleString("zh-CN")}</span><span>{share(item.count, data.canonical.healthRecords)}</span><span>当前数据集</span></div>)}</div>
        </section>

        <section className="audit-reference-panel missing-panel">
          <h2>特征缺失原因</h2>
          {topMissing.length ? <div className="audit-table"><div className="audit-tr head"><span>#　缺失原因</span><span>影响记录数</span><span>占比</span><span>统计范围</span></div>{topMissing.map((item, index) => <div className="audit-tr" key={item.reason}><span>{index + 1}　{item.reason}</span><span>{item.count.toLocaleString("zh-CN")}</span><span>{share(item.count, data.canonical.trainingSessions)}</span><span>当前数据集</span></div>)}</div> : <div className="audit-reference-empty"><CheckCircle size={24} /> 当前 active Feature 没有结构化缺失原因</div>}
        </section>
      </div>

      <section className="audit-reference-panel issues-panel">
        <h2>导入质量问题</h2>
        {data.issues.length ? <div className="audit-table issues-table"><div className="audit-tr head"><span>严重级别</span><span>问题类型</span><span>问题描述</span><span>影响记录条数</span><span>状态</span></div>{data.issues.slice(0, 5).map((item) => <div className="audit-tr" key={`${item.severity}:${item.code}`}><span><b className={`severity ${item.severity}`}>{item.severity}</b></span><span>{item.code}</span><span>检测到需要复核的数据质量问题</span><span>{item.count.toLocaleString("zh-CN")}</span><span><b className="status-outline">待处理</b></span></div>)}</div> : <div className="audit-reference-empty"><CheckCircle size={24} /> 本次导入没有 canonical 或结构质量问题</div>}
      </section>

      <footer className="audit-health-bar"><ShieldCheck size={26} /><b>当前数据健康</b><strong>{totalIssues ? "待复核" : "良好"}</strong><span>数据完整性：{qualityScore}</span><span>心率覆盖：{heartAvg}</span><span>建议：继续保持良好的数据记录习惯</span><Link to="/data">返回数据与模型</Link></footer>
    </div>
  );
}
