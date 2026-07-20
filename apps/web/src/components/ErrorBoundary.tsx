import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
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
        <div className="page" role="alert">
          <h1>页面渲染失败</h1>
          <p>可以尝试重新加载本页；若问题持续，请返回概览后重试。</p>
          <p className="muted">{this.state.error.message}</p>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              this.setState({ error: null });
              window.location.href = "/";
            }}
          >
            返回概览
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => this.setState({ error: null })}
          >
            重试本页
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
