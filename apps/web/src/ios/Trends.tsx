import type { MobileTrendsResponse } from "@rai/api-contracts";

import { pace, shortDate } from "../format.js";
import { useRemote } from "../hooks.js";
import { TrendDown, TrendUp } from "../icons.js";
import {
  Card,
  formatMd,
  IosLoading,
  monthLabel,
  RecordRow,
} from "./shared.js";

export function IosTrends() {
  const result = useRemote<MobileTrendsResponse>("/v1/mobile/trends");
  if (!result.data) {
    return (
      <IosLoading error={result.error} onRetry={() => void result.reload()} />
    );
  }
  const data = result.data;
  const max = Math.max(...data.weeks.map((week) => week.distanceKm), 1);
  const change = data.distanceChangeFraction4Weeks;
  const taValues = data.ability
    .map((point) => point.trueAbility)
    .filter((value): value is number => value != null);

  return (
    <>
      <Card title="真实能力" action="TA / CA">
        {taValues.length < 2 ? (
          <div className="ios-trend-empty">有效能力点还不够，先积累校准中的训练</div>
        ) : (
          <>
            <div className="ios-trend-summary">
              <strong>
                {data.ability.at(-1)?.trueAbility == null
                  ? "--"
                  : data.ability.at(-1)!.trueAbility!.toFixed(1)}
              </strong>
              <small>
                {data.growthVelocityPerWeek == null
                  ? "周增速 --"
                  : `周增速 ${data.growthVelocityPerWeek >= 0 ? "+" : ""}${data.growthVelocityPerWeek.toFixed(2)}`}
                {data.decayPoints > 0 ? ` · 衰减 ${data.decayPoints.toFixed(1)}` : ""}
              </small>
            </div>
            <AbilityChart
              trueAbility={data.ability}
              currentAbility={data.currentAbility}
            />
          </>
        )}
      </Card>
      <Card title="周跑量趋势" action="12 周">
        {change == null ? (
          <div className="ios-trend-empty">
            近 8 周对比数据不足，还不能计算跑量变化
          </div>
        ) : (
          <div className="ios-trend-summary">
            <strong>
              {`${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`}
            </strong>
            <small>较 4 周前</small>
          </div>
        )}
        <div className="ios-trend-chart">
          {data.weeks.map((week) => (
            <div className="ios-trend-col" key={week.periodStart}>
              <i
                style={{
                  height: `${Math.max(5, (week.distanceKm / max) * 104)}px`,
                }}
              />
              <small>{formatMd(week.periodStart)}</small>
            </div>
          ))}
        </div>
      </Card>
      {data.insights.map((insight) => (
        <div className={`ios-insight ${insight.kind}`} key={insight.title}>
          {insight.kind === "positive" ? (
            <TrendUp size={19} />
          ) : (
            <TrendDown size={19} />
          )}
          <span>
            <b>{insight.title}</b>
            <small>{insight.detail}</small>
          </span>
        </div>
      ))}
      <Card title="个人纪录">
        <RecordRow
          label="5 公里最快"
          value={
            data.records.fastest5k
              ? pace(data.records.fastest5k.paceSecondsPerKm)
              : "--"
          }
          detail={
            data.records.fastest5k
              ? shortDate(data.records.fastest5k.startedAt)
              : null
          }
        />
        <RecordRow
          label="10 公里最快"
          value={
            data.records.fastest10k
              ? pace(data.records.fastest10k.paceSecondsPerKm)
              : "--"
          }
          detail={
            data.records.fastest10k
              ? shortDate(data.records.fastest10k.startedAt)
              : null
          }
        />
        <RecordRow
          label="单次最长距离"
          value={
            data.records.longestDistance
              ? `${data.records.longestDistance.distanceKm.toFixed(1)} km`
              : "--"
          }
          detail={
            data.records.longestDistance
              ? shortDate(data.records.longestDistance.startedAt)
              : null
          }
        />
        <RecordRow
          label="月最大跑量"
          value={
            data.records.biggestMonth
              ? `${data.records.biggestMonth.distanceKm.toFixed(1)} km`
              : "--"
          }
          detail={
            data.records.biggestMonth
              ? monthLabel(data.records.biggestMonth.month)
              : null
          }
        />
      </Card>
    </>
  );
}

function AbilityChart({
  trueAbility,
  currentAbility,
}: {
  trueAbility: MobileTrendsResponse["ability"];
  currentAbility: MobileTrendsResponse["currentAbility"];
}) {
  const values = [
    ...trueAbility.map((point) => point.trueAbility),
    ...currentAbility.map((point) => point.currentAbility),
  ].filter((value): value is number => value != null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 320;
  const height = 120;
  const points = trueAbility.filter((point) => point.trueAbility != null);
  const d = points
    .map((point, index) => {
      const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
      const y = height - ((point.trueAbility! - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="ios-ability-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="真实能力曲线">
      <path d={d} fill="none" stroke="#247446" strokeWidth="3" />
      {currentAbility.map((point) => {
        if (point.currentAbility == null || points.length === 0) return null;
        const first = Date.parse(points[0]!.date);
        const last = Date.parse(points.at(-1)!.date);
        const t = last === first ? 0.5 : (Date.parse(point.date) - first) / (last - first);
        const x = Math.max(0, Math.min(1, t)) * width;
        const y = height - ((point.currentAbility - min) / span) * height;
        return <circle key={point.id} cx={x} cy={y} r="3.5" fill="#ed6549" />;
      })}
    </svg>
  );
}
