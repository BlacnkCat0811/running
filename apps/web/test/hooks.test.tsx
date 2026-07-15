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

    apiMock.mockRejectedValueOnce(new Error("temporary failure"));
    await act(async () => {
      expect(await result.current.reload()).toBe(false);
    });

    expect(result.current.data).toEqual({ ready: true });
    expect(result.current.error).toBe("temporary failure");
    expect(result.current.loading).toBe(false);
  });
});
