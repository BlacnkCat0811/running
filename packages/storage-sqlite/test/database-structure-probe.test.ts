import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { isStructurallyReadable, probeDatabaseStructure } from "../src/database-structure-probe.js";

function withDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "rai-structure-probe-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createDatabase(directory: string, name: string): string {
  const path = join(directory, name);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB NOT NULL)");
  const insert = database.prepare("INSERT INTO items (label, payload) VALUES (?, ?)");
  for (let index = 0; index < 400; index += 1) {
    insert.run(`row-${index}`, Buffer.alloc(2048, index % 251));
  }
  database.close();
  return path;
}

function quickCheckVerdict(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return String((database.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check);
  } finally {
    database.close();
  }
}

function pageGeometry(path: string): { pageSize: number; pageCount: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      pageSize: Number((database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size),
      pageCount: Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count)
    };
  } finally {
    database.close();
  }
}

/** 在第 index 页的页内起始处写入 64 字节，模拟该页被静默篡改。 */
function flipPage(path: string, pageIndex: number, pageSize: number): void {
  const descriptor = openSync(path, "r+");
  try {
    writeSync(descriptor, Buffer.alloc(64, 0xa5), 0, 64, pageIndex * pageSize);
  } finally {
    closeSync(descriptor);
  }
}

test("健康库：探针通过，且页几何与文件大小自洽", () => {
  withDirectory((directory) => {
    const path = createDatabase(directory, "healthy.sqlite");
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, true);
    assert.equal(report.reason, undefined);
    assert.equal(report.pageCount! * report.pageSize!, statSync(path).size);
    assert.equal(report.sizeBytes, statSync(path).size);
    assert.ok(report.schemaObjects! > 0);
    assert.equal(isStructurallyReadable(path), true);
  });
});

test("不存在的文件：探针判不可读而不是抛错", () => {
  withDirectory((directory) => {
    const report = probeDatabaseStructure(join(directory, "absent.sqlite"));
    assert.equal(report.readable, false);
    assert.match(report.reason ?? "", /stat failed/);
  });
});

test("空文件：探针判不可读", () => {
  withDirectory((directory) => {
    const path = join(directory, "empty.sqlite");
    const descriptor = openSync(path, "w");
    closeSync(descriptor);
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, false);
    assert.match(report.reason ?? "", /empty/);
  });
});

test("非 SQLite 内容的文件：探针判不可读而不是抛错", () => {
  withDirectory((directory) => {
    const path = join(directory, "garbage.sqlite");
    const descriptor = openSync(path, "w");
    writeSync(descriptor, Buffer.alloc(8192, 0x7f));
    closeSync(descriptor);
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, false);
  });
});

test("文件被截断：探针检出（页数与文件大小不再自洽）", () => {
  withDirectory((directory) => {
    const path = createDatabase(directory, "truncated.sqlite");
    const size = statSync(path).size;
    truncateSync(path, Math.floor(size * 0.75));
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, false);
    assert.notEqual(report.reason, undefined);
  });
});

test("文件尾部被追加垃圾：探针检出（页几何与文件大小不再自洽）", () => {
  withDirectory((directory) => {
    // 与「被截断」不同的失败形态：这里 SQLite 自己能正常打开并读出 header，
    // 只有 `page_count x page_size === 文件大小` 这条判据能发现异常。
    // 真实场景是「复制/落盘多写了一页」。
    const path = createDatabase(directory, "padded.sqlite");
    const before = statSync(path).size;
    const descriptor = openSync(path, "a");
    try {
      writeSync(descriptor, Buffer.alloc(4096, 0x00));
    } finally {
      closeSync(descriptor);
    }
    assert.equal(statSync(path).size, before + 4096);
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, false);
    assert.match(report.reason ?? "", /size mismatch/);
  });
});

test("header 的 page_count 被改坏：探针检出", () => {
  withDirectory((directory) => {
    const path = createDatabase(directory, "bad-header.sqlite");
    const descriptor = openSync(path, "r+");
    try {
      // header 偏移 28 的 4 字节大端整数就是 page_count。
      writeSync(descriptor, Buffer.from([0xff, 0xff, 0x00, 0x00]), 0, 4, 28);
    } finally {
      closeSync(descriptor);
    }
    const report = probeDatabaseStructure(path);
    assert.equal(report.readable, false);
  });
});

/**
 * 这一条**故意断言「漏检」**：它是降级范围的登记，不是缺陷。
 *
 * 结构探针只读 header 与 schema 页，所以「页内字节被静默篡改」它看不见 —— 而
 * `PRAGMA quick_check` 看得见（同一份文件上同时断言）。将来若有人要提高探针强度，
 * 这个测试会失败并提醒他：等价性口径变了，`rai-deploy` 里那条「换探针必须留兜底」
 * 的前提需要重新论证。
 */
test("登记降级：单页被翻转时 quick_check 报错，而结构探针漏检", () => {
  withDirectory((directory) => {
    const path = createDatabase(directory, "flipped-page.sqlite");
    const { pageSize, pageCount } = pageGeometry(path);
    const victimPage = Math.floor(pageCount / 2);
    assert.ok(victimPage > 1, "需要至少 3 页才能安全地翻转一个非 header 页");
    flipPage(path, victimPage, pageSize);

    assert.notEqual(quickCheckVerdict(path), "ok", "quick_check 应当检出页内损坏");
    assert.equal(
      probeDatabaseStructure(path).readable,
      true,
      "结构探针读不出页内损坏 —— 这正是它必须留 quick_check 兜底的原因"
    );
  });
});
