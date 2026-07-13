import type { WorkoutListResponse } from "@rai/api-contracts";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
} from "../components/Feedback.js";
import { WorkoutTable } from "../components/WorkoutTable.js";
import { useRemote } from "../hooks.js";
import { FunnelSimple } from "../icons.js";

const limit = 30;
const filterKeys = [
  "participation",
  "status",
  "environment",
  "days",
  "sourceGroup",
  "confidence",
  "route",
  "sessionType",
  "stimulusType",
] as const;
const filterValues: Record<(typeof filterKeys)[number], ReadonlySet<string>> = {
  participation: new Set(["included", "not_included"]),
  status: new Set(["eligible", "trial", "excluded"]),
  environment: new Set(["outdoor", "indoor", "unknown"]),
  days: new Set(["28", "90", "365"]),
  sourceGroup: new Set(["apple_watch", "third_party", "manual"]),
  confidence: new Set(["high", "medium", "low"]),
  route: new Set(["available", "missing"]),
  sessionType: new Set([
    "easy",
    "steady",
    "tempo",
    "interval",
    "long_run",
    "recovery",
    "race",
    "unknown",
  ]),
  stimulusType: new Set([
    "recovery",
    "aerobic_base",
    "marathon_pace",
    "lactate_threshold",
    "vo2max",
    "anaerobic_endurance",
    "unclassified",
  ]),
};

export function WorkoutsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedOffset = Number(searchParams.get("offset") ?? 0);
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(Math.floor(parsedOffset), 0)
    : 0;
  const sanitizedParams = new URLSearchParams();
  for (const key of filterKeys) {
    const candidate = searchParams.get(key);
    if (candidate && filterValues[key].has(candidate))
      sanitizedParams.set(key, candidate);
  }
  if (offset > 0) sanitizedParams.set("offset", String(offset));
  useEffect(() => {
    if (searchParams.toString() !== sanitizedParams.toString())
      setSearchParams(sanitizedParams, { replace: true });
  }, [searchParams, sanitizedParams, setSearchParams]);
  const value = (key: (typeof filterKeys)[number]) =>
    sanitizedParams.get(key) ?? "";
  const update = (key: string, nextValue: string) => {
    const next = new URLSearchParams(sanitizedParams);
    if (nextValue) next.set(key, nextValue);
    else next.delete(key);
    next.delete("offset");
    setSearchParams(next, { replace: true });
  };
  const setOffset = (nextOffset: number) => {
    const next = new URLSearchParams(sanitizedParams);
    if (nextOffset > 0) next.set("offset", String(nextOffset));
    else next.delete("offset");
    setSearchParams(next, { replace: true });
  };
  const apiParams = new URLSearchParams(sanitizedParams);
  apiParams.set("limit", String(limit));
  apiParams.set("offset", String(offset));
  const result = useRemote<WorkoutListResponse>(
    `/v1/workouts?${apiParams.toString()}`,
  );
  const activeFilterCount = filterKeys.filter((key) =>
    Boolean(value(key)),
  ).length;

  return (
    <div className="page">
      <header className="page-header split">
        <div>
          <h1>训练记录</h1>
          <p>查看每次跑步的特征、评分证据与数据质量。</p>
        </div>
        <div className="filter-summary">
          <span>
            {activeFilterCount ? `${activeFilterCount} 个筛选条件` : "全部训练"}
          </span>
          {activeFilterCount ? (
            <button
              className="text-button"
              onClick={() => setSearchParams({}, { replace: true })}
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </header>
      <div className="filter-bar">
        <FunnelSimple size={18} />
        <label>
          <span>模型参与</span>
          <select
            value={value("participation")}
            onChange={(event) => update("participation", event.target.value)}
          >
            <option value="">全部</option>
            <option value="included">参与模型</option>
            <option value="not_included">未参与模型</option>
          </select>
        </label>
        <label>
          <span>资格</span>
          <select
            value={value("status")}
            onChange={(event) => update("status", event.target.value)}
          >
            <option value="">全部</option>
            <option value="eligible">有效</option>
            <option value="trial">试算</option>
            <option value="excluded">排除</option>
          </select>
        </label>
        <label>
          <span>环境</span>
          <select
            value={value("environment")}
            onChange={(event) => update("environment", event.target.value)}
          >
            <option value="">全部</option>
            <option value="outdoor">户外</option>
            <option value="indoor">室内</option>
            <option value="unknown">未知</option>
          </select>
        </label>
        <label>
          <span>时间</span>
          <select
            value={value("days")}
            onChange={(event) => update("days", event.target.value)}
          >
            <option value="">全部</option>
            <option value="28">最近 4 周</option>
            <option value="90">最近 3 个月</option>
            <option value="365">最近 1 年</option>
          </select>
        </label>
        <label>
          <span>来源</span>
          <select
            value={value("sourceGroup")}
            onChange={(event) => update("sourceGroup", event.target.value)}
          >
            <option value="">全部</option>
            <option value="apple_watch">Apple Watch</option>
            <option value="third_party">第三方</option>
            <option value="manual">手工记录</option>
          </select>
        </label>
        <label>
          <span>置信度</span>
          <select
            value={value("confidence")}
            onChange={(event) => update("confidence", event.target.value)}
          >
            <option value="">全部</option>
            <option value="high">高 ≥ 80%</option>
            <option value="medium">中 60–79%</option>
            <option value="low">低 &lt; 60%</option>
          </select>
        </label>
        <label>
          <span>路线</span>
          <select
            value={value("route")}
            onChange={(event) => update("route", event.target.value)}
          >
            <option value="">全部</option>
            <option value="available">有路线</option>
            <option value="missing">无路线</option>
          </select>
        </label>
        <label>
          <span>结构</span>
          <select
            value={value("sessionType")}
            onChange={(event) => update("sessionType", event.target.value)}
          >
            <option value="">全部</option>
            <option value="easy">轻松跑</option>
            <option value="steady">稳态跑</option>
            <option value="tempo">节奏跑</option>
            <option value="interval">间歇跑</option>
            <option value="long_run">长距离</option>
            <option value="race">比赛</option>
            <option value="recovery">恢复跑</option>
            <option value="unknown">未分类</option>
          </select>
        </label>
        <label>
          <span>生理刺激</span>
          <select
            value={value("stimulusType")}
            onChange={(event) => update("stimulusType", event.target.value)}
          >
            <option value="">全部</option>
            <option value="recovery">恢复训练</option>
            <option value="aerobic_base">有氧基础训练</option>
            <option value="marathon_pace">马拉松配速训练</option>
            <option value="lactate_threshold">乳酸阈值训练</option>
            <option value="vo2max">最大摄氧量训练</option>
            <option value="anaerobic_endurance">无氧耐力训练</option>
            <option value="unclassified">未识别刺激</option>
          </select>
        </label>
      </div>
      <section className="panel workout-list-panel">
        {result.loading ? (
          <LoadingBlock />
        ) : result.error ? (
          <ErrorBlock
            message={result.error}
            onRetry={() => void result.reload()}
          />
        ) : result.data && result.data.items.length > 0 ? (
          <>
            <WorkoutTable items={result.data.items} />
            <div className="pagination">
              <span>
                {offset + 1}-{Math.min(offset + limit, result.data.total)} /{" "}
                {result.data.total}
              </span>
              <div>
                <button
                  className="button secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  上一页
                </button>
                <button
                  className="button secondary"
                  disabled={offset + limit >= result.data.total}
                  onClick={() => setOffset(offset + limit)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyBlock
            title="没有符合条件的训练"
            body="调整筛选条件，或前往数据页导入新的 Apple Health 导出。"
          />
        )}
      </section>
    </div>
  );
}
