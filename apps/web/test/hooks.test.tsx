import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));

import { useRemote } from "../src/hooks.js";

describe("useRemote", () => {
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
});
