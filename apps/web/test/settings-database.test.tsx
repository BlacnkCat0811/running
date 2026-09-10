import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, useRemoteMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  useRemoteMock: vi.fn(),
}));

vi.mock("../src/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly body: unknown) {
      super(message);
    }
  },
  api: apiMock,
  readApiToken: () => "",
  writeApiToken: () => {},
}));
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));

import { SettingsPage } from "../src/pages/SettingsPage.js";

const reloadBackups = vi.fn().mockResolvedValue(true);
const loadingRemote = {
  data: null,
  dataPath: null,
  error: null,
  loading: true,
  reload: vi.fn(),
};

function renderSettings(databaseReady = true) {
  return render(<MemoryRouter><SettingsPage databaseReady={databaseReady} /></MemoryRouter>);
}

async function confirmDatabaseDeletion() {
  fireEvent.click(screen.getByRole("button", { name: "删除数据库" }));
  fireEvent.change(screen.getByLabelText("确认文字"), {
    target: { value: "删除我的 RAI 数据" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
}

describe("SettingsPage database preservation", () => {
  beforeEach(() => {
    apiMock.mockReset();
    reloadBackups.mockClear();
    useRemoteMock.mockImplementation((path: string) =>
      path === "/v1/backups"
        ? { ...loadingRemote, data: [], loading: false, reload: reloadBackups }
        : loadingRemote,
    );
  });

  afterEach(cleanup);

  it("identifies a readable database preservation as a recoverable backup", async () => {
    apiMock.mockResolvedValue({
      deleted: true,
      preservation: {
        kind: "backup",
        backup: {
          name: "rai.before-delete.sqlite",
          sizeBytes: 1024,
          createdAt: new Date().toISOString(),
        },
      },
    });
    renderSettings();

    await confirmDatabaseDeletion();

    expect(await screen.findByText(/可恢复的删除前备份：rai\.before-delete\.sqlite/)).toBeTruthy();
    expect(reloadBackups).toHaveBeenCalledOnce();
  });

  it("identifies corrupt database preservation as a non-restorable quarantine snapshot", async () => {
    apiMock.mockResolvedValue({
      deleted: true,
      preservation: {
        kind: "quarantine",
        snapshot: {
          name: "rai.corrupt.sqlite",
          sizeBytes: 2048,
          createdAt: new Date().toISOString(),
        },
      },
    });
    const view = renderSettings();

    await confirmDatabaseDeletion();

    expect(await screen.findByText(/损坏数据库已隔离，仅供取证，不能直接恢复：rai\.corrupt\.sqlite/)).toBeTruthy();
    await waitFor(() => expect(reloadBackups).toHaveBeenCalledOnce());
    expect(view.container.querySelector(".backup-list")?.textContent ?? "").not.toContain("rai.corrupt.sqlite");
  });

  it("confirms a deleted database through health after the response is lost", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/database" && init?.method === "DELETE") {
        return Promise.reject(new Error("connection reset after delete"));
      }
      if (path === "/v1/health") {
        return Promise.resolve({ status: "recovery_required", databaseReady: false });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    renderSettings();

    await confirmDatabaseDeletion();

    expect(await screen.findByText("本地数据库已删除；连接中断后已通过运行状态确认。")).toBeTruthy();
    expect(screen.queryByText("connection reset after delete")).toBeNull();
    expect(reloadBackups).toHaveBeenCalledOnce();
  });

  it("confirms a restored database through health after the response is lost", async () => {
    const backup = {
      name: "rai.restore.sqlite",
      sizeBytes: 1024,
      createdAt: new Date().toISOString(),
    };
    useRemoteMock.mockImplementation((path: string) =>
      path === "/v1/backups"
        ? { ...loadingRemote, data: [backup], loading: false, reload: reloadBackups }
        : loadingRemote,
    );
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/backups/rai.restore.sqlite/restore" && init?.method === "POST") {
        return Promise.reject(new Error("connection reset after restore"));
      }
      if (path === "/v1/health") {
        return Promise.resolve({ status: "ok", databaseReady: true });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    renderSettings(false);
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.change(screen.getByLabelText("恢复确认文字"), {
      target: { value: "恢复此备份" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));

    expect(await screen.findByText("已恢复备份：rai.restore.sqlite；连接中断后已通过运行状态确认。")).toBeTruthy();
    expect(screen.queryByText("connection reset after restore")).toBeNull();
    expect(reloadBackups).toHaveBeenCalledOnce();
  });
});
