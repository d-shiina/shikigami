import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Last line of defence: without it, any render or effect error unmounts the
 * whole tree and Studio turns into a blank window. Scenario data lives in
 * Core, so recovering only needs a re-render.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Studio crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="canvas-bg flex h-full items-center justify-center p-8">
        <div className="w-[480px] space-y-3 rounded-[4px] border border-shu-100 bg-sheet p-6 shadow-dialog">
          <div className="flex items-center gap-2">
            <img src="/mark.png" alt="" className="h-6 w-6" />
            <h1 className="text-lg font-semibold">画面の表示中にエラーが起きました</h1>
          </div>
          <p className="text-sm text-slate-600">
            シナリオはCoreに保存されているため失われていません。「再表示」で画面を戻せます。
          </p>
          <pre className="max-h-40 overflow-auto rounded border border-slate-200 bg-paper p-2 font-mono text-xs whitespace-pre-wrap text-shu-600">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-[4px] bg-ink px-3 py-1 text-sm text-paper hover:bg-slate-700"
            >
              再表示
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-[4px] border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100"
            >
              再読み込み
            </button>
          </div>
        </div>
      </div>
    );
  }
}
