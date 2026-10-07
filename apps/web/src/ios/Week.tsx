import type { MobileTodayResponse, WorkoutListResponse } from "@rai/api-contracts";
import { useEffect } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { duration, sessionKind } from "../format.js";
import { useRemote } from "../hooks.js";
import {
  Card,
  EmptyState,
  formatMd,
  IosLoading,
  shanghaiDate,
  Stat,
  weekDay,
  WorkoutRow,
} from "./shared.js";

const weekWorkoutsPath = "/v1/workouts?limit=100&days=28";

export function IosWeekDetail() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const today = useRemote<MobileTodayResponse>("/v1/mobile/today");
  const workouts = useRemote<WorkoutListResponse>(weekWorkoutsPath);
  const stateDay = (location.state as { day?: string } | null)?.day;
  const selectedDay = params.get("day") ?? stateDay ?? null;

  useEffect(() => {
    if (!selectedDay) return;
    document
      .getElementById(`ios-day-${selectedDay}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedDay]);

  if (!today.data) {
    return (
      <IosLoading error={today.error} onRetry={() => void today.reload()} />
    );
  }

  const data = today.data;
  const max = Math.max(...data.weekDaily.map((item) => item.distanceKm), 1);
  const trainedDays = data.weekDaily.filter((item) => item.workoutCount > 0).length;
  const weekItems = (workouts.data?.items ?? []).filter((item) =>
    inCurrentWeek(item.startedAt, data.week.periodStart, data.week.periodEnd),
  );
  const visibleItems = selectedDay
    ? weekItems.filter((item) => shanghaiDate(item.startedAt) === selectedDay)
    : weekItems;

  function selectDay(day: string) {
    const next = new URLSearchParams(params);
    if (selectedDay === day) next.delete("day");
    else next.set("day", day);
    setParams(next, { replace: true });
  }

  return (
    <>
      <section className="ios-week-hero">
        <div className="ios-week-hero-copy">
          <span>
            {formatMd(data.week.periodStart)} – {formatMd(data.week.periodEnd)}
          </span>
          <strong>
            {data.week.distanceKm.toFixed(1)} <small>km</small>
          </strong>
          <p>本周已跑</p>
          <small className="ios-hero-footnote">
            {data.week.workoutCount} 次训练 · {duration(data.week.durationSeconds)}
          </small>
        </div>
      </section>
      <div className="ios-stat-grid">
        <Stat label="本周次数" value={String(data.week.workoutCount)} />
        <Stat label="本周时长" value={duration(data.week.durationSeconds)} />
        <Stat label="日均跑量" value={`${(data.week.distanceKm / 7).toFixed(1)} km`} />
        <Stat label="训练天数" value={`${trainedDays}/7`} />
      </div>
      <Card title="每日跑量">
        <div className="ios-week-chart">
          {data.weekDaily.map((item) => (
            <button
              type="button"
              className={`ios-week-column${item.localDate === data.today.localDate ? " today" : ""}${item.localDate === selectedDay ? " selected" : ""}`}
              key={item.localDate}
              onClick={() => selectDay(item.localDate)}
            >
              <div
                className="ios-week-bar"
                style={{
                  height: `${Math.max(8, (item.distanceKm / max) * 84)}px`,
                }}
              />
              <small>{weekDay(item.localDate)}</small>
            </button>
          ))}
        </div>
        <div className="ios-day-list">
          {data.weekDaily.map((item) => (
            <button
              type="button"
              className={`ios-day-row${item.localDate === data.today.localDate ? " today" : ""}${item.localDate === selectedDay ? " selected" : ""}`}
              id={`ios-day-${item.localDate}`}
              key={item.localDate}
              onClick={() => selectDay(item.localDate)}
            >
              <span>
                {weekDay(item.localDate)}
                <small>{formatMd(item.localDate)}</small>
              </span>
              <b>{item.distanceKm.toFixed(1)} km</b>
              <small>{item.workoutCount ? `${item.workoutCount} 次` : "休息"}</small>
            </button>
          ))}
        </div>
      </Card>
      <Card title="本周结构">
        <div className="ios-fact-list">
          <div className="ios-fact">
            <small>轻松时长</small>
            <b>
              {data.weekStructure.easyDurationFraction == null
                ? "--"
                : `${Math.round(data.weekStructure.easyDurationFraction * 100)}%`}
            </b>
          </div>
          <div className="ios-fact">
            <small>质量课</small>
            <b>
              {data.weekStructure.qualitySessionCount}/{data.weekStructure.qualitySessionCap}
            </b>
          </div>
        </div>
        <p className="ios-phy-copy">{data.weekStructure.easyHonesty.note}</p>
        <div className="ios-day-list">
          {data.weekPlan.map((day) => (
            <div className="ios-day-row" key={`plan-${day.localDate}`}>
              <span>
                {weekDay(day.localDate)}
                <small>{day.title}</small>
              </span>
              <b>{sessionKind(day.kind)}</b>
              <small>{day.kind === "completed" ? `${day.distanceKm.toFixed(1)} km` : "计划"}</small>
            </div>
          ))}
        </div>
      </Card>
      <Card title="本周训练">
        {workouts.error && !workouts.data ? (
          <IosLoading
            error={workouts.error}
            onRetry={() => void workouts.reload()}
          />
        ) : visibleItems.length ? (
          <div className="ios-workout-list">
            {visibleItems.map((workout) => (
              <WorkoutRow key={workout.id} workout={workout} detailed />
            ))}
          </div>
        ) : (
          <EmptyState
            label={
              selectedDay ? "这一天没有训练记录" : "本周还没有训练记录"
            }
          />
        )}
      </Card>
    </>
  );
}

function inCurrentWeek(startedAt: string, start: string, end: string) {
  const day = shanghaiDate(startedAt);
  return day >= start && day <= end;
}
