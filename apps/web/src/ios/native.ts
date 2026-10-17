import { useEffect, useState } from "react";

export type RaiNative = {
  reachable: boolean;
  lastSyncAt: string | null;
  lastSyncMessage: string | null;
  lastSyncError: string | null;
  lastWorkoutCount: number | null;
  isBusy: boolean;
};

type NativeMessage =
  | { action: "syncHealth"; routeRetryWorkoutIds?: string[] }
  /**
   * 定点修复**损坏的增量游标**（只清坏掉的那一个，不重置已同步数据、不重读全部历史）。
   * 「重新导入全部」已停用：全量同步会让 `sync_state` 与全部游标一起重置，
   * 与"永不自动清空游标"的边界冲突（见 docs/HEALTHKIT_RECORD_SYNC_V2.md）。
   */
  | { action: "repairSyncCursor" }
  | { action: "openServer" }
  | { action: "openHealthSettings" }
  | { action: "reload" };

type WebkitRai = {
  messageHandlers?: {
    rai?: { postMessage: (message: NativeMessage) => void };
  };
};

const idleNative: RaiNative = {
  reachable: false,
  lastSyncAt: null,
  lastSyncMessage: null,
  lastSyncError: null,
  lastWorkoutCount: null,
  isBusy: false,
};

function webkit(): WebkitRai | undefined {
  return (window as unknown as { webkit?: WebkitRai }).webkit;
}

export function hasNativeBridge(): boolean {
  return typeof webkit()?.messageHandlers?.rai?.postMessage === "function";
}

export function postNative(message: NativeMessage): void {
  webkit()?.messageHandlers?.rai?.postMessage(message);
}

export function readNativeStatus(): RaiNative {
  const value = (window as unknown as { __raiNative?: Partial<RaiNative> }).__raiNative;
  if (!value || typeof value !== "object") return idleNative;
  return {
    reachable: Boolean(value.reachable),
    lastSyncAt: value.lastSyncAt ?? null,
    lastSyncMessage: value.lastSyncMessage ?? null,
    lastSyncError: value.lastSyncError ?? null,
    lastWorkoutCount: typeof value.lastWorkoutCount === "number" ? value.lastWorkoutCount : null,
    isBusy: Boolean(value.isBusy),
  };
}

export function useNativeStatus(): RaiNative {
  const [status, setStatus] = useState(readNativeStatus);
  useEffect(() => {
    const sync = () => setStatus(readNativeStatus());
    window.addEventListener("rai:native-status", sync);
    return () => window.removeEventListener("rai:native-status", sync);
  }, []);
  return status;
}
