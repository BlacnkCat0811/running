import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.js";
import { useApiToken } from "./api-token.js";

/**
 * 常规读取的默认 deadline（毫秒）。
 *
 * 为什么要有默认值：`fetch` 本身没有超时，而"请求既没完成也没报错"（服务端 hang、
 * 代理挂住、连接被静默丢弃）在浏览器里是一条**无界等待** —— 页面会永久停在 loading，
 * 用户既看不到错误也没有重试路径。超时能力此前已经存在，只是**默认关闭**，
 * 于是常规读取全都落在无界状态（审计 3.9）。
 *
 * 为什么是 15 秒：**这是参数，不是验收标准**。本地 API 的常规读端点都在毫秒级返回，
 * 15 秒只是"明显不正常"的下界。真正决定它合不合适的是"慢查询会不会被误杀"，
 * 那需要按端点实测，不能靠这个数字拍板。
 *
 * 2026-10-09 按端点实测（只读 GET；本机 n=30，线上 tpandmr.xyz n=10）：
 *   · `/v1/training-statistics/load?days=180`：本机 p95 **15ms**；线上 p50 91ms / p95 **1700ms**
 *     （p50 与 p95 差 19 倍 ⇒ 是冷缓存长尾，不是稳态慢）。
 *   · `/v1/workouts/:id/share-card`：本机 p95 **294ms**（线上该端点被 token 门控，匿名只读测不到）。
 *   · `/v1/predictions?mode=current_prepared`：本机 p95 **2275ms**；线上 p95 **5512ms**
 *     —— 计算型端点（每次重算，无缓存），且成本随数据量单调增长。
 * ⇒ 三者都还在预算内，所以**这条默认值不动**；但**最紧的是 predictions（线上余量约 2.7×）**，
 *   它才是"数据量再涨就该单独给一个更长 deadline"的那个端点。
 *   ⚠️ 真要改，先在**目标机器**上重新取一次数（本机数字说明不了线上，线上余量只有本机的 1/2.4）。
 *
 * 长任务不走这里：导出/导入是"提交 + 轮询"，用的是 `DataModelPage` 里自己的
 * `XMLHttpRequest.timeout`（默认 0 = 不超时），不受本默认值影响。
 * 需要更长或彻底关闭时，调用方显式传 `timeoutMs`（`null` = 不超时）。
 */
const DEFAULT_REMOTE_TIMEOUT_MS = 15_000;

export function useRemote<T>(
  path: string,
  enabled = true,
  backgroundRefresh = false,
  refreshOnDataUpdate = true,
  timeoutMs: number | null = DEFAULT_REMOTE_TIMEOUT_MS,
) {
  const token = useApiToken();
  const [data, setData] = useState<T | null>(null);
  const dataRef = useRef<T | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Track path/enabled so the first render after a change is not a stale success frame.
  const [requestKey, setRequestKey] = useState({ path, enabled, token });
  if (requestKey.path !== path || requestKey.enabled !== enabled || requestKey.token !== token) {
    const credentialsChanged = requestKey.token !== token;
    setRequestKey({ path, enabled, token });
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (!enabled) {
      dataRef.current = null;
      setData(null);
      setDataPath(null);
      setError(null);
      setLoading(false);
    } else if (!backgroundRefresh || credentialsChanged) {
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
    // `fetch` 本身没有超时，而"请求既不完成也不报错"是一条无界等待 —— 默认套一层 deadline
    // （`DEFAULT_REMOTE_TIMEOUT_MS`），让首屏能从 loading 落到可重试的错误态；调用方可传
    // `timeoutMs = null` 显式关掉它。
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
  }, [backgroundRefresh, enabled, path, timeoutMs, token]);
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
