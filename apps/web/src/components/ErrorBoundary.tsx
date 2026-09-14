import { Component, type ErrorInfo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 用函数组件承载回退 UI，才能在类组件里使用路由导航。
 * 原先用 window.location.href 强刷整页，会丢掉 SPA 状态（也在子路径部署下不可用）。
 */
function BoundaryFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="page" role="alert">
      <h1>页面渲染失败</h1>
      <p>可以尝试重新加载本页；若问题持续，请返回概览后重试。</p>
      <p className="muted">{error.message}</p>
      <button
        type="button"
        className="button primary"
        onClick={() => {
          // 先导航再清错误：两者同时批处理，子组件会在 "/" 上重新挂载。
          navigate("/", { replace: true });
          onReset();
        }}
      >
        返回概览
      </button>
      <button type="button" className="button secondary" onClick={onReset}>
        重试本页
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UI render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <BoundaryFallback
          error={this.state.error}
          onReset={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
