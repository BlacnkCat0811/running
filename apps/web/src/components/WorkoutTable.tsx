import type { WorkoutListItem } from "@rai/api-contracts";
import { Link, useLocation } from "react-router-dom";

import { date, duration, environment, missingReason, number, pace, sessionType, source, stimulusType } from "../format.js";
import { MapTrifold } from "../icons.js";
import { StatusBadge } from "./StatusBadge.js";

export function WorkoutTable({ items, compact = false }: { items: WorkoutListItem[]; compact?: boolean }) {
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  return (
    <div className="workout-table-wrap">
      <table className={`workout-table ${compact ? "compact" : ""}`}>
        <thead><tr><th>日期</th><th>训练</th><th>距离</th><th>配速</th><th>心率</th><th>CA</th><th>置信度</th><th>状态</th></tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td><Link to={`/workouts/${item.id}`} state={{ from }} className="row-link">{date(item.startedAt, true)}</Link></td>
              <td><span className="session-label">{sessionType(item.sessionType)}{item.hasRoute ? <MapTrifold size={14} aria-label="有路线" /> : null}</span><small className="stimulus-label">{stimulusType(item.stimulusType)} · {item.stimulusConfidence === null ? "--" : `${Math.round(item.stimulusConfidence * 100)}%`}</small><small>{environment(item.indoor)} · {source(item.sourceCategory)} · {duration(item.durationSeconds)}</small></td>
              <td className="numeric">{number(item.distanceKm)} km</td>
              <td className="numeric">{pace(item.averagePaceSecondsPerKm)}/km</td>
              <td className="numeric">{item.averageHeartRateBpm === null ? "--" : Math.round(item.averageHeartRateBpm)}</td>
              <td className="numeric ca-value">{number(item.currentAbility)}</td>
              <td className="numeric">{item.confidence === null ? "--" : `${Math.round(item.confidence * 100)}%`}</td>
              <td><StatusBadge value={item.assessmentStatus ?? item.eligibilityStatus} />{item.missingReasons[0] ? <small className="status-reason">{missingReason(item.missingReasons[0])}</small> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="workout-mobile-list">
        {items.map((item) => (
          <Link key={item.id} to={`/workouts/${item.id}`} state={{ from }} className="workout-mobile-item">
            <span><b>{date(item.startedAt, true)}</b><small>{sessionType(item.sessionType)} · {stimulusType(item.stimulusType)}</small><small>{environment(item.indoor)} · {source(item.sourceCategory)}</small></span>
            <span className="numeric"><b>{number(item.distanceKm)} km</b><small>{pace(item.averagePaceSecondsPerKm)}/km</small></span>
            <span className="mobile-ca"><b>{number(item.currentAbility)}</b><small>CA</small></span>
          </Link>
        ))}
      </div>
    </div>
  );
}
