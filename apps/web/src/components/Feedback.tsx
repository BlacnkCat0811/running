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
  return (
    <div className="error-block" role="alert">
      <WarningCircle size={22} />
      <div><b>{title}</b><p>{message}</p></div>
      {onRetry ? <button className="button secondary" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return <div className="empty-block"><b>{title}</b><p>{body}</p></div>;
}
