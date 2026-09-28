import "./workout-summary-export.css";
import { useState } from "react";
import type { WorkoutSummaryExportResponse } from "@rai/api-contracts";
import { api } from "../api.js";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export function WorkoutSummaryExport() {
  const [from, setFrom] = useState(today);
  const [through, setThrough] = useState(today);
  const [result, setResult] = useState<WorkoutSummaryExportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api(`/v1/exports/workout-summary?${new URLSearchParams({ from, through })}`)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "导出暂不可用"); }
    finally { setBusy(false); }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `RAI-training-${result.from}-${result.through}.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel desktop-workout-export" aria-label="导出训练摘要">
    <h2>导出训练摘要</h2>
    <p>仅包含已分析训练的开始时间、类型、距离、时长和配速。不含路线、心率、备注或设备标识；不是完整健康数据备份。</p>
    <fieldset disabled={busy}>
      <label>开始日期 <input aria-label="导出开始日期" type="date" value={from} onChange={e => { setFrom(e.target.value); setResult(null); }} /></label>
      <label>结束日期 <input aria-label="导出结束日期" type="date" value={through} onChange={e => { setThrough(e.target.value); setResult(null); }} /></label>
      <p>日期按 Asia/Shanghai 统计。单次最多 366 天、2000 条，需在下方配置访问令牌。</p>
      <button className="button secondary" disabled={!from || !through || from > through} onClick={() => void prepare()}>{busy ? "正在准备" : "预览导出"}</button>
    </fieldset>
    {result && <p>将导出 {result.from} 至 {result.through} 的 {result.count} 条训练。 <button className="button primary" disabled={result.count === 0} onClick={download}>保存 CSV</button></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
