import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.js";

export function useRemote<T>(path: string, enabled = true, backgroundRefresh = false) {
  const [data, setData] = useState<T | null>(null);
  const dataRef = useRef<T | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    if (!enabled) {
      controllerRef.current = null;
      dataRef.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(!backgroundRefresh || dataRef.current === null);
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const next = await api<T>(path, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;
      dataRef.current = next;
      setData(next);
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [backgroundRefresh, enabled, path]);
  useEffect(() => {
    void reload();
    return () => controllerRef.current?.abort();
  }, [reload]);
  useEffect(() => {
    const refresh = () => { void reload(); };
    window.addEventListener("rai:data-updated", refresh);
    return () => window.removeEventListener("rai:data-updated", refresh);
  }, [reload]);
  return { data, error, loading, reload };
}
