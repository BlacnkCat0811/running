import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import {
  ArrowLeft,
  ChartBar,
  ChartLine,
  GearSix,
  House,
  PersonSimpleRun,
} from "../icons.js";
import { IosHome } from "./Home.js";
import { IosSettings } from "./Settings.js";
import { IosStatistics } from "./Statistics.js";
import { IosTrends } from "./Trends.js";
import { IosPhysiologyPage } from "./Physiology.js";
import { formatToday, greeting } from "./shared.js";
import { IosWeekDetail } from "./Week.js";
import { IosWorkoutDetail } from "./WorkoutDetail.js";
import { IosWorkouts } from "./Workouts.js";

const tabs = [
  ["/", "首页", House],
  ["/workouts", "训练", PersonSimpleRun],
  ["/statistics", "统计", ChartBar],
  ["/trends", "趋势", ChartLine],
  ["/settings", "设置", GearSix],
] as const;

const pageTitles: Record<string, string> = {
  "/": "首页",
  "/week": "本周活动",
  "/body": "身体指标",
  "/workouts": "训练",
  "/statistics": "统计",
  "/trends": "趋势",
  "/settings": "设置",
};

function titleForPath(pathname: string): string {
  const pageTitle = pathname.startsWith("/workouts/") && pathname !== "/workouts"
    ? "训练详情"
    : pageTitles[pathname] ?? "首页";
  return `${pageTitle} - RAI`;
}

export function IosMobileApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;
  const isWeek = pathname === "/week";
  const isBody = pathname === "/body";
  const isWorkoutDetail = /^\/workouts\/[^/]+$/.test(pathname);
  const isDetail = isWeek || isWorkoutDetail || isBody;
  const tabPath = pathname.startsWith("/workouts")
    ? "/workouts"
    : isWeek || isBody
      ? "/"
      : pathname;
  const heading = isWorkoutDetail
    ? "训练详情"
    : isWeek
      ? "本周活动"
      : isBody
        ? "身体指标"
        : tabPath === "/"
          ? greeting()
          : tabs.find(([to]) => to === tabPath)?.[1] ?? "首页";
  const returnTo =
    (location.state as { from?: string } | null)?.from ??
    (isWorkoutDetail ? "/workouts" : "/");

  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);

  return (
    <div className={`ios-mobile-app${isDetail ? " ios-detail" : ""}`}>
      <header className="ios-app-header">
        <div>
          {isDetail ? (
            <button
              type="button"
              className="ios-back-button"
              onClick={() => navigate(returnTo)}
            >
              <ArrowLeft size={16} /> 返回
            </button>
          ) : (
            <span className="ios-app-brand">RAI</span>
          )}
          <h1>{heading}</h1>
          {!isDetail && tabPath === "/" ? (
            <p>{formatToday()} · 保持今天的节奏</p>
          ) : null}
        </div>
        {isDetail ? null : (
          <button
            type="button"
            className="ios-profile-button"
            aria-label="个人资料"
            onClick={() => navigate("/settings")}
          >
            跑
          </button>
        )}
      </header>
      <main className="ios-mobile-content">
        <Routes>
          <Route path="/" element={<IosHome />} />
          <Route path="/week" element={<IosWeekDetail />} />
          <Route path="/body" element={<IosPhysiologyPage />} />
          <Route path="/workouts" element={<IosWorkouts />} />
          <Route path="/workouts/:id" element={<IosWorkoutDetail />} />
          <Route path="/statistics" element={<IosStatistics />} />
          <Route path="/trends" element={<IosTrends />} />
          <Route path="/settings" element={<IosSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="ios-mobile-tabbar" aria-label="iOS 应用导航">
        {tabs.map(([to, label, Icon]) => {
          const active = tabPath === to;
          return (
            <button
              key={to}
              type="button"
              className={active ? "active" : ""}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(to)}
            >
              <Icon size={22} weight={active ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
