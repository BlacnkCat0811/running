import { Link } from "react-router-dom";

import { WarningCircle } from "../icons.js";

export function LoadingBlock({ label = "正在读取本地数据" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <div className="skeleton-line wide" />
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ message, onRetry, title = "暂时无法读取数据" }: { message: string; onRetry?: () => void; title?: string }) {
  // 后端 local-request-security 对缺失或错误的令牌固定返回 401「需要有效的 API Token」；
  // 浏览器直连云端时用户无从得知去哪里填，这里补一个入口。
  const needsToken = message.includes("API Token");
  return (
    <div className="error-block" role="alert">
      <WarningCircle size={22} />
      <div><b>{title}</b><p>{message}</p></div>
      {needsToken ? <Link className="button secondary" to="/settings">配置令牌</Link> : null}
      {onRetry ? <button className="button secondary" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return <div className="empty-block"><b>{title}</b><p>{body}</p></div>;
}
