import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrivacyZonesResponse } from "@rai/api-contracts";

const mocks = vi.hoisted(() => ({ api: vi.fn(), useRemote: vi.fn() }));
vi.mock("../src/hooks.js", () => ({ useRemote: mocks.useRemote }));
vi.mock("../src/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api.js")>(), api: mocks.api
}));
import { ApiError, writeApiToken } from "../src/api.js";
import { PrivacyZoneEditor } from "../src/components/ShareCardPanel.js";
import { notifyDatabaseStateChanged, subscribePrivacyZonesChanged } from "../src/events.js";

const home = {
  id: "home", label: "家", centerLatitude: 31.23, centerLongitude: 121.47, radiusMeters: 300,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z"
};
const initialStateToken = "a".repeat(64);
const newer: PrivacyZonesResponse = { revision: 2, stateToken: "b".repeat(64), zones: [home, { ...home, id: "work", label: "公司" }] };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("rai.web.apiToken", "test-token");
});
afterEach(() => { cleanup(); localStorage.clear(); });

it("enables the mounted editor after saving a token and disables it on removal", () => {
  localStorage.clear();
  mocks.useRemote.mockReturnValue({ data: { revision: 0, stateToken: initialStateToken, zones: [] }, error: null, loading: false, reload: vi.fn() });
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  expect(mocks.useRemote.mock.lastCall?.[1]).toBe(false);
  act(() => writeApiToken("saved-token"));
  expect(mocks.useRemote.mock.lastCall?.[1]).toBe(true);
  expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  act(() => writeApiToken(""));
  expect(mocks.useRemote.mock.lastCall?.[1]).toBe(false);
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
});

it.each([
  ...["", "   ", "NaN", "Infinity", "91"].map(value => ["纬度", value]),
  ...["", "   ", "NaN", "Infinity", "181"].map(value => ["经度", value]),
  ...["", "   ", "NaN", "Infinity", "0", "-1", "5001"].map(value => ["半径 m", value])
])("refuses invalid %s %j before sending a write", async (field, value) => {
  mocks.useRemote.mockReturnValue({ data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn() });
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: field }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("alert").textContent).toContain("有效经纬度");
  expect(mocks.api).not.toHaveBeenCalled();
});

it("accepts explicit zero coordinates instead of treating zero as empty", async () => {
  const changed = vi.fn();
  const unsubscribe = subscribePrivacyZonesChanged(changed);
  mocks.useRemote.mockReturnValue({ data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn(async () => true) });
  mocks.api.mockResolvedValueOnce({ revision: 2, stateToken: newer.stateToken, zones: [home] });
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  for (const name of ["纬度", "经度"]) fireEvent.change(screen.getByRole("textbox", { name }), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.api.mock.calls[0]![1].body).zones[0]).toMatchObject({ centerLatitude: 0, centerLongitude: 0 });
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(localStorage.getItem("rai:privacy-zones-changed")).toBeTruthy();
  unsubscribe();
});

it("keeps the draft's original revision after a conflict and requires explicit discard", async () => {
  const remote = {
    data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false,
    reload: vi.fn(async () => { remote.data = newer; return true; })
  };
  mocks.useRemote.mockImplementation(() => remote);
  mocks.api.mockRejectedValueOnce(new ApiError("revision conflict", 409, {}));
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "旧草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true));
  await waitFor(() => expect(remote.reload).toHaveBeenCalledOnce());
  const sent = JSON.parse(mocks.api.mock.calls[0]![1].body as string);
  expect(sent.revision).toBe(1);
  expect(sent.stateToken).toBe(initialStateToken);
  expect(sent.zones[0].createdAt).toBe(home.createdAt);
  expect(screen.getByDisplayValue("旧草稿")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(mocks.api).toHaveBeenCalledOnce();

  remote.reload.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "丢弃草稿并重新加载" }));
  await waitFor(() => expect(remote.reload).toHaveBeenCalledTimes(2));
  expect(screen.getByDisplayValue("旧草稿")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "丢弃草稿并重新加载" }));
  await waitFor(() => expect(screen.getByDisplayValue("公司")).toBeTruthy());
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(false);
});

it("does not rebase a draft when a background refresh changes the remote revision", () => {
  const remote = { data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn() };
  mocks.useRemote.mockImplementation(() => remote);
  const view = render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "旧草稿" } });
  remote.data = newer;
  view.rerender(<PrivacyZoneEditor />);
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByDisplayValue("旧草稿")).toBeTruthy();
  expect(mocks.api).not.toHaveBeenCalled();
});

it("preserves a non-conflicting draft when retrying a failed save", async () => {
  const remote = { data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn(async () => true) };
  mocks.useRemote.mockImplementation(() => remote);
  mocks.api.mockRejectedValueOnce(new ApiError("temporary failure", 500, {}));
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "待重试" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "重新加载" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(remote.reload).toHaveBeenCalledTimes(2));
  expect(screen.getByDisplayValue("待重试")).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(false);
});

it("blocks a same-revision draft after restoring different collection contents", async () => {
  const restored: PrivacyZonesResponse = { revision: 1, stateToken: "c".repeat(64), zones: [{ ...home, label: "恢复后", centerLatitude: 32 }] };
  const remote = { data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null,
    loading: false, reload: vi.fn(async () => true) };
  mocks.useRemote.mockImplementation(() => remote);
  const view = render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "旧草稿" } });
  remote.data = restored;
  view.rerender(<PrivacyZoneEditor />);
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(mocks.api).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue("旧草稿")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "丢弃草稿并重新加载" }));
  await waitFor(() => expect(screen.getByDisplayValue("恢复后")).toBeTruthy());
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(false);
});

it("invalidates drafts immediately on database replacement, before the refresh finishes", () => {
  mocks.useRemote.mockReturnValue({ data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn() });
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "旧草稿" } });
  act(() => { notifyDatabaseStateChanged(); });
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.api).not.toHaveBeenCalled();
});

it("does not carry an unsaved draft into a changed credential scope", () => {
  mocks.useRemote.mockReturnValue({ data: { revision: 1, stateToken: initialStateToken, zones: [home] }, error: null, loading: false, reload: vi.fn() });
  render(<PrivacyZoneEditor />);
  fireEvent.click(screen.getByRole("button", { name: "编辑隐私区" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "旧草稿" } });
  act(() => writeApiToken("another-owner"));
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
});
