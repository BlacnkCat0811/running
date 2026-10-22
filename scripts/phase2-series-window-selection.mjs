// 阶段 2 热读窗口选择：纯函数，供基准脚本与夹具测试共用。
//
// 口径提醒：p25/p50/p75 是**可读训练按时间排序后的数量分位**，不是整个日历
// 跨度的 25%/50%/75%。窗口名只描述“有多少条可读训练排在它前面”：
//   oldest = 升序第一条；recent = 升序最后一条。
// 历史证据（2026-10-21/22）把这两个端点写反了；名称修正不改变任何测量值。
export const WINDOW_SELECTION_VERSION = "phase2-series-window-selection-v1";

/** 输出顺序保持历史证据的字段顺序，避免报告阅读习惯变化。 */
export const WINDOW_NAMES = Object.freeze(["recent", "p25", "p50", "p75", "oldest"]);

const WINDOW_RATIOS = Object.freeze({
  p25: 0.25,
  p50: 0.5,
  p75: 0.75
});

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function readableSessions(sessions) {
  if (!Array.isArray(sessions)) throw new TypeError("training sessions must be an array");
  return sessions.filter((session) => {
    if (!session || typeof session !== "object") return false;
    if (session.deletedAt !== undefined && session.deletedAt !== null) return false;
    if (session.status !== undefined && session.status !== "active") return false;
    return true;
  });
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
}

function compareSessions(left, right) {
  const delta = Date.parse(left.startedAt) - Date.parse(right.startedAt);
  return delta !== 0 ? delta : compareText(left.id, right.id);
}

/**
 * 给定统一的训练总数，计算窗口名称对应的唯一合法下标。
 *
 * 证据校验必须使用本函数，而不是只检查“两侧下标相同”：两侧同时把 recent
 * 写成 0、oldest 写成 N-1 时，相等但仍然是错的。
 */
export function expectedWindowIndex(name, readableSessions) {
  if (!WINDOW_NAMES.includes(name)) throw new Error(`unknown window name: ${name}`);
  if (!Number.isInteger(readableSessions) || readableSessions < 1) {
    throw new Error(`readableSessions must be a positive integer, got ${JSON.stringify(readableSessions)}`);
  }
  const lastIndex = readableSessions - 1;
  if (name === "oldest") return 0;
  if (name === "recent") return lastIndex;
  return Math.min(lastIndex, Math.max(0, Math.floor(lastIndex * WINDOW_RATIOS[name])));
}

/**
 * 从可读训练中选出五个热读窗口。
 *
 * 输入行至少需要 `{ id, startedAt }`；`status`/`deletedAt` 若存在会再次过滤，
 * 防止调用方漏掉 SQL 条件。返回数组已按 `startedAt, id` 升序稳定排列；同一
 * 开始时间按训练 ID 的代码单元顺序决定先后，重复运行结果一致。
 */
export function selectTrainingWindows(sessions) {
  const readable = readableSessions(sessions);
  if (readable.length === 0) throw new Error("no readable training sessions");

  const seen = new Set();
  for (const session of readable) {
    if (typeof session.id !== "string" || session.id.length === 0) {
      throw new Error(`training session id must be a non-empty string, got ${JSON.stringify(session.id)}`);
    }
    assertTimestamp(session.startedAt, `training session ${session.id} startedAt`);
    if (session.endedAt !== undefined && session.endedAt !== null) {
      assertTimestamp(session.endedAt, `training session ${session.id} endedAt`);
    }
    if (seen.has(session.id)) throw new Error(`duplicate training session id: ${session.id}`);
    seen.add(session.id);
  }

  const ordered = [...readable].sort(compareSessions);

  const windows = WINDOW_NAMES.map((name) => {
    const indexFromOldest = expectedWindowIndex(name, ordered.length);
    const session = ordered[indexFromOldest];
    return {
      name,
      id: session.id,
      trainingSessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      indexFromOldest
    };
  });

  return {
    windows,
    readableSessions: ordered.length,
    selection: {
      version: WINDOW_SELECTION_VERSION,
      orderBy: "anchor_start_at ascending, id ascending",
      quantileMethod: "floor((N-1) * ratio) over readable sessions; inclusive endpoints",
      quantileBasis: "readable training count, not calendar-time span",
      readableSessions: ordered.length
    }
  };
}
