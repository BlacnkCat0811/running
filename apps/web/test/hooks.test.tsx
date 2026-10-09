import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../src/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api.js")>(), api: apiMock
}));

import { useRemote } from "../src/hooks.js";
import { writeApiToken } from "../src/api.js";

afterEach(() => { cleanup(); localStorage.clear(); });

describe("useRemote", () => {
  it("clears privileged data immediately and ignores old responses when credentials change", async () => {
    writeApiToken("owner");
    let resolveOld: ((value: { route: number[] }) => void) | undefined;
    apiMock.mockResolvedValueOnce({ route: [1] });
    const { result } = renderHook(() => useRemote<{ route: number[] }>("/workout", true, true));
    await waitFor(() => expect(result.current.data).toEqual({ route: [1] }));
    apiMock.mockImplementationOnce(() => new Promise<{ route: number[] }>((resolve) => { resolveOld = resolve; }));
    let oldRequest: Promise<boolean>;
    act(() => { oldRequest = result.current.reload(); });
    let resolveAnonymous: ((value: { route: number[] }) => void) | undefined;
    apiMock.mockImplementationOnce(() => new Promise<{ route: number[] }>((resolve) => { resolveAnonymous = resolve; }));
    act(() => writeApiToken(""));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { resolveOld?.({ route: [2] }); await oldRequest!; });
    expect(result.current.data).toBeNull();
    await act(async () => { resolveAnonymous?.({ route: [] }); });
    expect(result.current.data).toEqual({ route: [] });
  });

  it("reports an initial request failure when no cached data exists", async () => {
    apiMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useRemote<{ ready: boolean }>("/health"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("offline");
  });

  it("keeps cached data when a background refresh fails", async () => {
    apiMock.mockResolvedValueOnce({ ready: true });
    const { result } = renderHook(() =>
      useRemote<{ ready: boolean }>("/health", true, true, false),
    );
    await waitFor(() => expect(result.current.data).toEqual({ ready: true }));
    expect(result.current.dataPath).toBe("/health");

    apiMock.mockRejectedValueOnce(new Error("temporary failure"));
    await act(async () => {
      expect(await result.current.reload()).toBe(false);
    });

    expect(result.current.data).toEqual({ ready: true });
    expect(result.current.error).toBe("temporary failure");
    expect(result.current.loading).toBe(false);
  });

  it("identifies which request produced cached data while the path changes", async () => {
    let resolveNext: ((value: { page: number }) => void) | undefined;
    apiMock
      .mockResolvedValueOnce({ page: 1 })
      .mockImplementationOnce(
        () => new Promise<{ page: number }>((resolve) => { resolveNext = resolve; }),
      );
    const { result, rerender } = renderHook(
      ({ path }) => useRemote<{ page: number }>(path),
      { initialProps: { path: "/workouts?offset=0" } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ page: 1 }));
    expect(result.current.dataPath).toBe("/workouts?offset=0");

    rerender({ path: "/workouts?offset=30" });
    // Non-background path changes clear the previous frame immediately.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.dataPath).toBeNull();
    await act(async () => { resolveNext?.({ page: 2 }); });

    await waitFor(() => expect(result.current.data).toEqual({ page: 2 }));
    expect(result.current.dataPath).toBe("/workouts?offset=30");
  });

  it("keeps background-refresh data visible across path changes until the next payload arrives", async () => {
    let resolveNext: ((value: { page: number }) => void) | undefined;
    apiMock
      .mockResolvedValueOnce({ page: 1 })
      .mockImplementationOnce(
        () => new Promise<{ page: number }>((resolve) => { resolveNext = resolve; }),
      );
    const { result, rerender } = renderHook(
      ({ path }) => useRemote<{ page: number }>(path, true, true, false),
      { initialProps: { path: "/workouts?offset=0" } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ page: 1 }));

    rerender({ path: "/workouts?offset=30" });
    expect(result.current.data).toEqual({ page: 1 });
    expect(result.current.dataPath).toBe("/workouts?offset=0");
    await act(async () => { resolveNext?.({ page: 2 }); });

    await waitFor(() => expect(result.current.data).toEqual({ page: 2 }));
    expect(result.current.dataPath).toBe("/workouts?offset=30");
  });

  // 显式配置的 timeoutMs 生效：本地 API 挂起时首屏要离开"正在检查本地数据库"。
  it("fails with a timeout message when the request never settles", async () => {
    vi.useFakeTimers();
    try {
      apiMock.mockImplementation(() => new Promise(() => {}));
      const { result } = renderHook(() =>
        useRemote<{ ready: boolean }>("/v1/health", true, false, true, 5000),
      );
      expect(result.current.loading).toBe(true);

      await act(async () => { vi.advanceTimersByTime(5000); });

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBe("请求超时（超过 5 秒）");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a request that resolves in time", async () => {
    vi.useFakeTimers();
    try {
      apiMock.mockResolvedValue({ ready: true });
      const { result } = renderHook(() =>
        useRemote<{ ready: boolean }>("/v1/health", true, false, true, 5000),
      );

      await act(async () => { await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(60000); });

      expect(result.current.data).toEqual({ ready: true });
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // 审计 3.9：常规读取必须**默认有界**。此前 `timeoutMs` 默认 null ⇒ 无界等待，
  // 页面可以永久停在 loading。期望值写死文案与秒数（不引用模块常量）：被锁的是
  // "默认值存在且为 15 秒"这个对外契约，引用常量会让测试跟着实现一起漂移。
  it("applies a bounded wait to a default (unconfigured) read", async () => {
    vi.useFakeTimers();
    try {
      apiMock.mockImplementation(() => new Promise(() => {}));
      const { result } = renderHook(() => useRemote<{ ready: boolean }>("/v1/health"));
      expect(result.current.loading).toBe(true);

      await act(async () => { vi.advanceTimersByTime(15_000); });

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBe("请求超时（超过 15 秒）");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the wait unbounded only when the caller explicitly opts out with null", async () => {
    vi.useFakeTimers();
    try {
      apiMock.mockImplementation(() => new Promise(() => {}));
      const { result } = renderHook(() =>
        useRemote<{ ready: boolean }>("/v1/health", true, false, true, null),
      );

      await act(async () => { vi.advanceTimersByTime(120_000); });

      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
