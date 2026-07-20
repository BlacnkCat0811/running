import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.js";

export function useRemote<T>(
  path: string,
  enabled = true,
  backgroundRefresh = false,
  refreshOnDataUpdate = true,
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
    try {
      const next = await api<T>(path, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return true;
      dataRef.current = next;
      setData(next);
      setDataPath(path);
      return true;
    } catch (caught) {
      if (requestId !== requestIdRef.current) return true;
      if (controller.signal.aborted) return false;
      setError(caught instanceof Error ? caught.message : "请求失败");
      return false;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [backgroundRefresh, enabled, path]);
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
