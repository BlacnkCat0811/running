import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkoutSummaryExport } from "../src/components/WorkoutSummaryExport.js";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("requires preview, resets it after range edits, and never downloads implicitly", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ from: "2026-09-01", through: "2026-09-28", count: 2, timezone: "Asia/Shanghai", csv: "csv" }))));
  render(<WorkoutSummaryExport />);
  expect(screen.queryByRole("button", { name: "保存 CSV" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "预览导出" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存 CSV" })).toBeTruthy());
  fireEvent.change(screen.getByLabelText("导出开始日期"), { target: { value: "2026-09-02" } });
  expect(screen.queryByRole("button", { name: "保存 CSV" })).toBeNull();
});
it("shows an actionable authentication error without a download", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"message":"请配置访问令牌并连接后导出"}', { status: 401 })));
  render(<WorkoutSummaryExport />);
  fireEvent.click(screen.getByRole("button", { name: "预览导出" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("访问令牌"));
  expect(screen.queryByRole("button", { name: "保存 CSV" })).toBeNull();
});
