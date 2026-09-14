import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.js";

export function useRemote<T>(
  path: string,
  enabled = true,
  backgroundRefresh = false,
  refreshOnDataUpdate = true,
  timeoutMs: number | null = null,
) {
  const [data, setData] = useState<T | null>(null);
  const dataRef = useRef<T | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Track path/enabled so the first render after a change is not a stale success frame.
  const [requestKey, setRequestKey] = useState({ path, enabled });
  if (requestKey.path !== path || requestKey.enabled !== enabled) {
    setRequestKey({ path, enabled });
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (!enabled) {
      dataRef.current = null;
      setData(null);
      setDataPath(null);
      setError(null);
      setLoading(false);
    } else if (!backgroundRefresh) {
      dataRef.current = null;
      setData(null);
      setDataPath(null);
      setError(null);
      setLoading(true);
    } else {
      setError(null);
      setLoading(dataRef.current === null);
    }
  }
  const reload = useCallback(async (): Promise<boolean> => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    if (!enabled) {
      controllerRef.current = null;
      dataRef.current = null;
      setData(null);
      setDataPath(null);
      setError(null);
      setLoading(false);
      return true;
    }
    setLoading(!backgroundRefresh || dataRef.current === null);
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    // fetch 本身没有超时：API 无响应时首屏会永久停在 loading。仅在显式配置 timeoutMs 时启用。
    // 用竞速而不是只 abort：底层若不响应 abort 信号，光 abort 不会让 await 结束。
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout =
      timeoutMs === null
        ? null
        : new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
            }, timeoutMs);
          });
    try {
      const request = api<T>(path, { signal: controller.signal });
      const next = await (timeout === null ? request : Promise.race([request, timeout]));
      if (requestId !== requestIdRef.current) return true;
      dataRef.current = next;
      setData(next);
      setDataPath(path);
      return true;
    } catch (caught) {
      if (requestId !== requestIdRef.current) return true;
      if (timedOut) {
        setError(caught instanceof Error ? caught.message : "请求超时");
        return false;
      }
      if (controller.signal.aborted) return false;
      setError(caught instanceof Error ? caught.message : "请求失败");
      return false;
    } finally {
      // 清掉定时器：请求先完成时超时 Promise 永远不会 reject，不会产生未处理的拒绝。
      if (timer !== null) clearTimeout(timer);
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [backgroundRefresh, enabled, path, timeoutMs]);
  useEffect(() => {
    void reload();
    return () => controllerRef.current?.abort();
  }, [reload]);
  useEffect(() => {
    if (!refreshOnDataUpdate) return;
    const refresh = () => { void reload(); };
    window.addEventListener("rai:data-updated", refresh);
    return () => window.removeEventListener("rai:data-updated", refresh);
  }, [refreshOnDataUpdate, reload]);
  return { data, dataPath, error, loading, reload };
}
