import type { WorkoutListItem, WorkoutListResponse } from "@rai/api-contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { sessionType } from "../format.js";
import { useRemote } from "../hooks.js";
import { Card, EmptyState, IosLoading, WorkoutRow } from "./shared.js";

const sessionFilters = [
  "easy",
  "tempo",
  "interval",
  "long_run",
  "recovery",
  "steady",
  "race",
] as const;

const dayFilters = [28, 90] as const;
const statusFilters = [
  { value: "eligible", label: "有效" },
  { value: "trial", label: "试算" },
  { value: "excluded", label: "排除" },
] as const;
const sourceFilters = [
  { value: "apple_watch", label: "Watch" },
  { value: "third_party", label: "第三方" },
  { value: "manual", label: "手工" },
] as const;
const environmentFilters = [
  { value: "outdoor", label: "户外" },
  { value: "indoor", label: "室内" },
] as const;
const pageSize = 30;

function workoutsPath(
  type: string | null,
  days: number | null,
  status: string | null,
  sourceGroup: string | null,
  environment: string | null,
  offset: number,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(pageSize));
  params.set("offset", String(offset));
  if (type) params.set("sessionType", type);
  if (days != null) params.set("days", String(days));
  if (status) params.set("status", status);
  if (sourceGroup) params.set("sourceGroup", sourceGroup);
  if (environment) params.set("environment", environment);
  return `/v1/workouts?${params.toString()}`;
}

export function IosWorkouts() {
  const [type, setType] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sourceGroup, setSourceGroup] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [extra, setExtra] = useState<WorkoutListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const path = workoutsPath(type, days, status, sourceGroup, environment, 0);
  const result = useRemote<WorkoutListResponse>(path);

  useEffect(() => {
    setExtra([]);
    setLoadError(null);
  }, [path]);

  const items = result.data ? [...result.data.items, ...extra] : [];
  const total = result.data?.total ?? 0;
  const canLoadMore = Boolean(result.data) && items.length < total;

  async function loadMore() {
    setLoadingMore(true);
    setLoadError(null);
    try {
      const next = await api<WorkoutListResponse>(
        workoutsPath(type, days, status, sourceGroup, environment, items.length),
      );
      setExtra((current) => [...current, ...next.items]);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "加载失败");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <div className="ios-chip-row" role="group" aria-label="训练类型">
        <Chip
          label="全部"
          pressed={type === null}
          onClick={() => setType(null)}
        />
        {sessionFilters.map((value) => (
          <Chip
            key={value}
            label={sessionType(value)}
            pressed={type === value}
            onClick={() => setType(value)}
          />
        ))}
      </div>
      <div className="ios-chip-row" role="group" aria-label="时间范围">
        {dayFilters.map((value) => (
          <Chip
            key={value}
            label={`${value}天`}
            pressed={days === value}
            onClick={() => setDays(value)}
          />
        ))}
        <Chip
          label="全部"
          pressed={days === null}
          onClick={() => setDays(null)}
        />
      </div>
      <div className="ios-chip-row" role="group" aria-label="资格">
        <Chip label="全部资格" pressed={status === null} onClick={() => setStatus(null)} />
        {statusFilters.map((item) => (
          <Chip
            key={item.value}
            label={item.label}
            pressed={status === item.value}
            onClick={() => setStatus(item.value)}
          />
        ))}
      </div>
      <div className="ios-chip-row" role="group" aria-label="来源与环境">
        {sourceFilters.map((item) => (
          <Chip
            key={item.value}
            label={item.label}
            pressed={sourceGroup === item.value}
            onClick={() => setSourceGroup(sourceGroup === item.value ? null : item.value)}
          />
        ))}
        {environmentFilters.map((item) => (
          <Chip
            key={item.value}
            label={item.label}
            pressed={environment === item.value}
            onClick={() => setEnvironment(environment === item.value ? null : item.value)}
          />
        ))}
      </div>
      <Card title="全部训练">
        {!result.data ? (
          <IosLoading error={result.error} onRetry={() => void result.reload()} />
        ) : (
          <>
            <div className="ios-workout-list">
              {items.length ? (
                items.map((workout) => (
                  <WorkoutRow key={workout.id} workout={workout} detailed />
                ))
              ) : (
                <EmptyState label="还没有训练记录" />
              )}
            </div>
            {canLoadMore ? (
              <button
                type="button"
                className="ios-save"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "加载中…" : "加载更多"}
              </button>
            ) : null}
            {loadError ? <p className="ios-sync-error">{loadError}</p> : null}
          </>
        )}
      </Card>
    </>
  );
}

function Chip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ios-chip${pressed ? " active" : ""}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
