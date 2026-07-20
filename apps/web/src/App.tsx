import "./first-run-pixel.css";
import { lazy, Suspense, useEffect, useRef } from "react";
import type { HealthResponse } from "@rai/api-contracts";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  Link,
  useLocation,
} from "react-router-dom";

import { LoadingBlock } from "./components/Feedback.js";
import { GlobalTaskStatus } from "./components/GlobalTaskStatus.js";
import { ErrorBlock } from "./components/Feedback.js";
import { useRemote } from "./hooks.js";
import {
  ArrowRight,
  ChartBar,
  ChartLine,
  Database,
  DotsThree,
  GearSix,
  Heartbeat,
  House,
  PersonSimpleRun,
  ShieldCheck,
  Target,
  Timer,
  Warning,
} from "./icons.js";

const DashboardPage = lazy(() =>
  import("./pages/DashboardPage.js").then((module) => ({
    default: module.DashboardPage,
  })),
);
const PredictionsPage = lazy(() =>
  import("./pages/PredictionsPage.js").then((module) => ({
    default: module.PredictionsPage,
  })),
);
const DataModelPage = lazy(() =>
  import("./pages/DataModelPage.js").then((module) => ({
    default: module.DataModelPage,
  })),
);
const DataAuditPage = lazy(() =>
  import("./pages/DataAuditPage.js").then((module) => ({
    default: module.DataAuditPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage.js").then((module) => ({
    default: module.SettingsPage,
  })),
);
const StatisticsPage = lazy(() =>
  import("./pages/StatisticsPage.js").then((module) => ({
    default: module.StatisticsPage,
  })),
);
const TrendsPage = lazy(() =>
  import("./pages/TrendsPage.js").then((module) => ({
    default: module.TrendsPage,
  })),
);
const WorkoutDetailPage = lazy(() =>
  import("./pages/WorkoutDetailPage.js").then((module) => ({
    default: module.WorkoutDetailPage,
  })),
);
const WorkoutsPage = lazy(() =>
  import("./pages/WorkoutsPage.js").then((module) => ({
    default: module.WorkoutsPage,
  })),
);
const TrainingZonesPage = lazy(() =>
  import("./pages/TrainingZonesPage.js").then((module) => ({
    default: module.TrainingZonesPage,
  })),
);

const desktopNavigation = [
  { to: "/", label: "概览", icon: House, end: true },
  { to: "/workouts", label: "训练", icon: PersonSimpleRun },
  { to: "/zones", label: "分区", icon: Target },
  { to: "/statistics", label: "统计", icon: ChartBar },
  { to: "/trends", label: "趋势", icon: ChartLine },
  { to: "/predictions", label: "预测", icon: Timer },
  { to: "/data", label: "数据与模型", icon: Database, end: true },
  { to: "/data/audit", label: "数据审计", icon: ShieldCheck },
  { to: "/settings", label: "设置", icon: GearSix },
];

const mobileNavigation = [
  { to: "/", label: "概览", icon: House, end: true },
  { to: "/workouts", label: "训练", icon: PersonSimpleRun },
  { to: "/statistics", label: "统计", icon: ChartBar },
  { to: "/trends", label: "趋势", icon: ChartLine },
  { to: "/more", label: "更多", icon: DotsThree },
];

const pageTitles: Record<string, string> = {
  "/": "概览",
  "/workouts": "训练记录",
  "/zones": "训练分区",
  "/statistics": "运动统计",
  "/trends": "能力趋势",
  "/predictions": "成绩预测",
  "/data": "数据与模型",
  "/data/audit": "数据审计",
  "/settings": "设置",
  "/more": "更多",
};

function titleForPath(pathname: string): string {
  const pageTitle = pathname.startsWith("/workouts/")
    ? "训练详情"
    : pageTitles[pathname] ?? "个人跑步能力";
  return `${pageTitle} - RAI`;
}

function NavigationLinks({
  items,
  className,
}: {
  items: typeof desktopNavigation;
  className: string;
}) {
  const location = useLocation();
  const visibleItems =
    className === "desktop-nav-links" && location.pathname !== "/data/audit"
      ? items.filter((item) => item.to !== "/data/audit")
      : items;
  const moreIsActive = ["/zones", "/predictions", "/data", "/settings"].some(
    (path) =>
      location.pathname === path || location.pathname.startsWith(`${path}/`),
  );
  return (
    <div className={`nav-links ${className}`}>
      {visibleItems.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end ?? false}
          className={({ isActive }) =>
            isActive || (to === "/more" && moreIsActive) ? "active" : ""
          }
        >
          <Icon size={19} weight="regular" />
          <span>{label}</span>
        </NavLink>
      ))}
    </div>
  );
}

function AppNavigation() {
  return (
    <nav className="app-navigation" aria-label="主导航">
      <div className="brand-lockup">
        <span className="brand-mark">
          <Heartbeat size={18} weight="bold" />
        </span>
        <span>
          <b>RAI</b>
          <small>Running intelligence</small>
        </span>
      </div>
      <NavigationLinks
        items={desktopNavigation}
        className="desktop-nav-links"
      />
      <NavigationLinks items={mobileNavigation} className="mobile-nav-links" />
      <div className="local-note">
        <span className="local-note-runner" aria-hidden="true" />
        <span className="local-note-copy">
          <b>保持进步</b>
          <b>享受跑步</b>
          <small aria-hidden="true">♥ ♥ ◆</small>
        </span>
      </div>
    </nav>
  );
}

export function App() {
  const health = useRemote<HealthResponse>("/v1/health", true, true, false);
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef<string | null>(null);
  useEffect(() => {
    const refreshDatabaseState = () => {
      void health.reload();
    };
    window.addEventListener("rai:database-state-changed", refreshDatabaseState);
    return () =>
      window.removeEventListener(
        "rai:database-state-changed",
        refreshDatabaseState,
      );
  }, [health.reload]);
  const location = useLocation();
  useEffect(() => {
    document.title = titleForPath(location.pathname);
    if (
      previousPathname.current !== null &&
      previousPathname.current !== location.pathname
    ) {
      mainRef.current?.focus({ preventScroll: true });
    }
    previousPathname.current = location.pathname;
  }, [location.pathname]);
  const canOpenWithoutDatabase =
    location.pathname === "/data" ||
    location.pathname === "/settings" ||
    location.pathname === "/more";
  const content = health.loading ? (
    <div className="page">
      <LoadingBlock label="正在检查本地数据库" />
    </div>
  ) : !health.data ? (
    <div className="page">
      <ErrorBlock
        message={health.error ?? "无法连接本地 API"}
        onRetry={() => void health.reload()}
      />
    </div>
  ) : !health.data.databaseReady && !canOpenWithoutDatabase ? (
    <FirstRunPage />
  ) : (
    <Suspense
      fallback={
        <div className="page">
          <LoadingBlock />
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/workouts" element={<WorkoutsPage />} />
        <Route path="/workouts/:id" element={<WorkoutDetailPage />} />
        <Route path="/zones" element={<TrainingZonesPage />} />
        <Route path="/statistics" element={<StatisticsPage />} />
        <Route path="/trends" element={<TrendsPage />} />
        <Route path="/predictions" element={<PredictionsPage />} />
        <Route
          path="/data"
          element={<DataModelPage databaseReady={health.data.databaseReady} />}
        />
        <Route path="/data/audit" element={<DataAuditPage />} />
        <Route
          path="/settings"
          element={<SettingsPage databaseReady={health.data.databaseReady} />}
        />
        <Route path="/more" element={<MorePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <AppNavigation />
      <GlobalTaskStatus />
      <main
        ref={mainRef}
        id="main-content"
        className="app-content"
        tabIndex={-1}
      >
        {health.error && health.data ? (
          <div className="background-refresh-error" role="status">
            <Warning size={18} />
            <span>
              <b>数据库状态刷新失败</b>
              <small>{health.error}，当前继续显示上次成功读取的数据。</small>
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => void health.reload()}
            >
              重试
            </button>
          </div>
        ) : null}
        {content}
      </main>
    </div>
  );
}

function MorePage() {
  const items = [
    {
      to: "/zones",
      label: "训练分区",
      icon: Target,
      detail: "心率储备、阈配速与每日冻结快照",
    },
    {
      to: "/predictions",
      label: "成绩预测",
      icon: Timer,
      detail: "VDOT、专项准备度与比赛预测",
    },
    {
      to: "/data",
      label: "数据与模型",
      icon: Database,
      detail: "导入、重算和模型历史",
    },
    {
      to: "/settings",
      label: "设置",
      icon: GearSix,
      detail: "备份、恢复与本地隐私",
    },
  ];
  return (
    <div className="page more-page">
      <header className="page-header">
        <h1>更多</h1>
        <p>预测、数据管理与本地设置</p>
      </header>
      <section className="panel more-links">
        {items.map(({ to, label, icon: Icon, detail }) => (
          <Link key={to} to={to}>
            <Icon size={22} />
            <span>
              <b>{label}</b>
              <small>{detail}</small>
            </span>
            <ArrowRight size={17} />
          </Link>
        ))}
      </section>
    </div>
  );
}

function FirstRunPage() {
  return (
    <div className="page first-run-page">
      <section className="first-run-hero">
        <span className="brand-mark">
          <Heartbeat size={20} weight="bold" />
        </span>
        <p className="eyebrow">本地数据库尚未准备</p>
        <h1>
          从 Apple Health 导出
          <br />
          建立你的 RAI 时间线
        </h1>
        <p>
          选择本机 Apple Health 导出目录后，系统会在临时 SQLite
          中完成解析、canonical 收敛、特征提取和模型回放，全部成功才激活数据库。
        </p>
        <Link to="/data" className="button primary">
          前往导入 <ArrowRight size={16} />
        </Link>
        <div className="first-run-scene" aria-hidden="true">
          <i className="scene-skyline" />
          <i className="scene-tree tree-left" />
          <i className="scene-tree tree-right" />
          <i className="scene-route" />
          <span className="scene-marker marker-start">01</span>
          <span className="scene-marker marker-heart">♥</span>
          <span className="scene-marker marker-medal">★</span>
          <span className="scene-flag" />
          <span className="scene-runner" />
        </div>
        <p className="first-run-disclaimer">
          RAI
          是个人训练趋势工具，不是医疗设备，不能用于诊断疾病或替代专业医疗建议。
        </p>
      </section>
      <section className="first-run-steps">
        <article>
          <b>01</b>
          <span>
            <h2>导出健康数据</h2>
            <p>在 iPhone 健康 App 中导出全部健康数据，并解压到本机目录。</p>
          </span>
        </article>
        <article>
          <b>02</b>
          <span>
            <h2>本地验证</h2>
            <p>XML、GPX、健康 Record 与 Workout 只在本机解析，不上传云端。</p>
          </span>
        </article>
        <article>
          <b>03</b>
          <span>
            <h2>原子激活</h2>
            <p>导入和重算全部成功后才切换当前数据库，失败不会覆盖已有数据。</p>
          </span>
        </article>
        <div className="first-run-privacy">
          <ShieldCheck size={18} />
          API 固定监听 127.0.0.1
        </div>
      </section>
    </div>
  );
}
