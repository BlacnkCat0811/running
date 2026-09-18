import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Fastify from "fastify";

import {
  importJobBodySchema,
  importSourceBodySchema,
  mobileGoalsBodySchema,
  openapiDocument,
  predictionModelIdParamsSchema,
  predictionModelTrainBodySchema,
  recoveryTrendQuerySchema,
  trainingZoneProfileBodySchema,
  trainingZonesHistoryQuerySchema,
  trainingLoadQuerySchema,
  trainingStatisticsHistoryQuerySchema,
  workoutListQuerySchema
} from "../src/schemas.js";
import {
  balancedBlock,
  propertyBody,
  readStripped,
  skipBalanced,
  sourceFiles,
  stripComments,
  swiftSources
} from "./source-scan.js";

/**
 * The receiver a write route is mounted on.
 *
 * `app.` was the whole pattern, so a route module written the idiomatic way —
 * `export async function routes(fastify: FastifyInstance)` — mounted write
 * routes this file could not see, and the counting invariant beside it proved
 * nothing because it counted `app.` too. The names below are what a Fastify
 * instance is actually called; an alias (`const a = app`) or a cast still slips
 * past any text scan, which is why the authoritative check is the route table
 * the router itself reports (`server-runtime.test.ts`, `RAI_ROUTE_DUMP`). This
 * one stays because it fails next to the source that broke the rule.
 */
const ROUTER = "(?:app|fastify|server|instance|router|plugin|api)";

test("OpenAPI operations declare responses and write contracts", () => {
  for (const [path, pathItem] of Object.entries(openapiDocument.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      assert.ok("responses" in operation, `${method.toUpperCase()} ${path} is missing responses`);
      const success = operation.responses["200"];
      if (success && "content" in success && "application/json" in success.content) {
        const schema = success.content["application/json"].schema;
        const candidates = ("anyOf" in schema ? schema.anyOf : [schema]) as readonly Record<string, unknown>[];
        for (const candidate of candidates) {
          if (!("type" in candidate) || candidate.type === "null") continue;
          const object = (candidate.type === "array" ? candidate.items : candidate) as Record<string, unknown>;
          assert.ok("properties" in object && Object.keys(object.properties as object).length > 0,
            `${method.toUpperCase()} ${path} has an empty success object schema`);
          assert.ok("required" in object && (object.required as unknown[]).length > 0,
            `${method.toUpperCase()} ${path} does not declare stable response fields`);
        }
      }
    }
  }
  const importOperation = openapiDocument.paths["/v1/import-jobs"].post;
  assert.ok("requestBody" in importOperation);
  const workoutOperation = openapiDocument.paths["/v1/workouts/{id}"].get;
  assert.ok("parameters" in workoutOperation);
  assert.ok("components" in openapiDocument);
  assert.ok("413" in openapiDocument.paths["/v1/imports/uploads"].post.responses);
  assert.ok("415" in openapiDocument.paths["/v1/imports/uploads"].post.responses);
  assert.ok("429" in openapiDocument.paths["/v1/imports/uploads"].post.responses);
  assert.ok("507" in openapiDocument.paths["/v1/imports/uploads"].post.responses);
  assert.ok("/v1/import-jobs/latest" in openapiDocument.paths);
  const importJobSchema = openapiDocument.components.schemas.ImportJobResponse;
  assert.deepEqual(importJobSchema.required, [
    "id", "status", "phase", "message", "createdAt", "completedAt", "error"
  ]);
  assert.ok("sourceId" in importJobSchema.properties);
  assert.ok("progress" in importJobSchema.properties);
  assert.ok("summary" in importJobSchema.properties);
  const latestImportSchema = openapiDocument.paths["/v1/import-jobs/latest"].get.responses["200"]
    .content["application/json"].schema as { anyOf: Array<{ $ref?: string }> };
  assert.equal(latestImportSchema.anyOf[0]?.$ref, "#/components/schemas/ImportJobResponse");
  const cancellationSchema = openapiDocument.paths["/v1/jobs/{id}/cancel"].post.responses["200"]
    .content["application/json"].schema as { required: string[] };
  assert.deepEqual(cancellationSchema.required, ["cancelRequested", "status"]);
  const deletionSchema = openapiDocument.paths["/v1/database"].delete.responses["200"]
    .content["application/json"].schema as {
      properties: { preservation: { oneOf: unknown[] } };
    };
  assert.equal(deletionSchema.properties.preservation.oneOf.length, 2);
  assert.ok("422" in openapiDocument.paths["/v1/prediction-models/train"].post.responses);
});

test("inspect source schema rejects missing and additional fields", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post("/inspect", { schema: { body: importSourceBodySchema } }, async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: "POST", url: "/inspect", payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/inspect", payload: { sourceId: "x", extra: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/inspect", payload: { sourceId: "source-1" } })).statusCode, 200);
  } finally { await app.close(); }
});

test("import job schema accepts only a source identifier", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post("/imports", { schema: { body: importJobBodySchema } }, async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: "POST", url: "/imports" })).statusCode, 400);
    assert.equal((await app.inject({
      method: "POST", url: "/imports", payload: "null",
      headers: { "content-type": "application/json" }
    })).statusCode, 400);
    for (const payload of [[], {}, { inputPath: "x" },
      { sourceId: "source-1", confirmReplace: true },
      { inputPath: "x", confirmReplace: true, sourceId: "source-1" }]) {
      const response = await app.inject({ method: "POST", url: "/imports", payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await app.inject({
      method: "POST", url: "/imports", payload: { sourceId: "source-1" }
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "POST", url: "/imports", payload: { inputPath: "D:/export", confirmReplace: true }
    })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("prediction training schema rejects ambiguous timestamps and unknown input", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post("/train", { schema: { body: predictionModelTrainBodySchema } }, async () => ({ ok: true }));
  try {
    const ambiguous = await app.inject({
      method: "POST",
      url: "/train",
      payload: { asOf: "July 11, 2026" }
    });
    assert.equal(ambiguous.statusCode, 400);

    const unknown = await app.inject({
      method: "POST",
      url: "/train",
      payload: { asOf: "2026-07-11T00:00:00.000Z", force: true }
    });
    assert.equal(unknown.statusCode, 400);

    const impossibleDate = await app.inject({
      method: "POST",
      url: "/train",
      payload: { asOf: "2026-02-30T00:00:00Z" }
    });
    assert.equal(impossibleDate.statusCode, 400);

    const endOfDay = await app.inject({
      method: "POST",
      url: "/train",
      payload: { asOf: "2026-07-11T24:00:00Z" }
    });
    assert.equal(endOfDay.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/train",
      payload: { asOf: "2026-07-11T08:00:00+08:00" }
    });
    assert.equal(valid.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("workout list queries accept eligibility filters and reject calibrating status", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.get("/workouts", { schema: { querystring: workoutListQuerySchema } }, async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: "GET", url: "/workouts" })).statusCode, 200);
    assert.equal((await app.inject({
      method: "GET",
      url: "/workouts?status=eligible&stimulusType=lactate_threshold&sessionType=tempo&days=90&limit=30&offset=0"
    })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/workouts?days=4000" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/workouts?status=calibrating" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/workouts?status=unknown" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/workouts?extra=1" })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("training statistics queries constrain ranges and granularities", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.get("/history", { schema: { querystring: trainingStatisticsHistoryQuerySchema } }, async () => ({ ok: true }));
  app.get("/load", { schema: { querystring: trainingLoadQuerySchema } }, async () => ({ ok: true }));
  app.get("/zones", { schema: { querystring: trainingZonesHistoryQuerySchema } }, async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: "GET", url: "/history?granularity=week&limit=52" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/history?granularity=day" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/history?granularity=month&extra=1" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/load?days=180" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/load?days=forever" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/zones?days=90" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/zones?days=all" })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("recovery trend queries require a whole-day range within the supported window", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.get("/recovery-trends", { schema: { querystring: recoveryTrendQuerySchema } }, async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=28" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=365" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=0" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=1.5" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=366" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/recovery-trends?days=abc" })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("training-zone settings require consistent automatic and manual values", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.patch("/zones", { schema: { body: trainingZoneProfileBodySchema } }, async () => ({ ok: true }));
  const automatic = {
    expectedRevision: 0,
    restingHeartRate: { mode: "auto", valueBpm: null },
    maximumHeartRate: { mode: "auto", valueBpm: null },
    lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
  };
  try {
    assert.equal((await app.inject({ method: "PATCH", url: "/zones", payload: automatic })).statusCode, 200);
    assert.equal((await app.inject({
      method: "PATCH",
      url: "/zones",
      payload: { ...automatic, restingHeartRate: { mode: "auto", valueBpm: 55 } }
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: "PATCH",
      url: "/zones",
      payload: { ...automatic, maximumHeartRate: { mode: "manual", valueBpm: null } }
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: "PATCH",
      url: "/zones",
      payload: {
        ...automatic,
        restingHeartRate: { mode: "manual", valueBpm: 52 },
        maximumHeartRate: { mode: "manual", valueBpm: 195 },
        lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
      }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("prediction model routes accept only generated model identifiers", async () => {
  const app = Fastify();
  app.get<{ Params: { id: string } }>(
    "/models/:id",
    { schema: { params: predictionModelIdParamsSchema } },
    async (request) => ({ id: request.params.id })
  );
  try {
    const invalid = await app.inject({ method: "GET", url: "/models/../../var/rai.sqlite" });
    assert.notEqual(invalid.statusCode, 200);

    const validId = "prediction_model_550e8400-e29b-41d4-a716-446655440000";
    const valid = await app.inject({ method: "GET", url: `/models/${validId}` });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.json(), { id: validId });
  } finally {
    await app.close();
  }
});

test("the goals schema keeps step goals and alerts inside their own semantic bounds", async () => {
  const app = Fastify();
  app.post("/goals", { schema: { body: mobileGoalsBodySchema } }, async () => ({ ok: true }));
  const step = (goal: unknown, alert: unknown = null) => ({ purpose: "work", goal, alert });
  const goals = (structure: unknown) => ({
    weeklyDistanceKm: 30,
    weekPlan: [{ localDate: "2026-09-07", kind: "interval", distanceKm: 8, structure }]
  });
  const structure = (goal: unknown, alert: unknown = null) => ({
    warmup: null,
    cooldown: null,
    blocks: [{ iterations: 6, steps: [step(goal, alert)] }]
  });
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/goals", payload });

  try {
    // Well-formed prescriptions of every goal type must still be accepted.
    assert.equal((await post(goals(structure({ type: "distance", meters: 800 }, { kind: "pace", lower: 240, upper: 265 })))).statusCode, 200);
    assert.equal((await post(goals(structure({ type: "time", seconds: 480 }, { kind: "heart_rate", lower: 150, upper: 165 })))).statusCode, 200);
    assert.equal((await post(goals(structure({ type: "open" })))).statusCode, 200);

    // A goal may only carry the field its own type uses.
    assert.equal((await post(goals(structure({ type: "time", seconds: 480, meters: 900 })))).statusCode, 400);
    assert.equal((await post(goals(structure({ type: "distance" })))).statusCode, 400);

    // Heart-rate and pace alerts are bounded by different units.
    assert.equal((await post(goals(structure({ type: "time", seconds: 300 }, { kind: "heart_rate", lower: 150, upper: 400 })))).statusCode, 400);
    assert.equal((await post(goals(structure({ type: "time", seconds: 300 }, { kind: "pace", lower: 300, upper: 340 })))).statusCode, 200);
    assert.equal((await post(goals(structure({ type: "time", seconds: 300 }, { kind: "cadence", lower: 160, upper: 180 })))).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("every registered mutation route is documented in OpenAPI", () => {
  // New endpoints have twice gone missing from `openapiDocument` while every
  // neighbouring route was listed, so the registries in `server.ts` — the one
  // place that decides what is actually mounted — are the source of truth here.
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const registry = (name: string): string[] => {
    const block = new RegExp("const " + name + " = new Set\\(\\[([\\s\\S]*?)\\]\\)").exec(source);
    assert.ok(block, "server.ts 必须声明 " + name);
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  };
  const metadataOnly = registry("metadataOnlyMutationRoutes");
  const databaseRequired = registry("databaseRequiredMutationRoutes");
  const lockOnly = registry("lockOnlyMutationRoutes");
  const registered = [...metadataOnly, ...databaseRequired, ...lockOnly];
  assert.ok(registered.length > 0, "至少要登记一条写路由");
  for (const route of registered) {
    const documented = route.replace(/:(\w+)/g, "{$1}");
    assert.ok(documented in openapiDocument.paths, documented + " 已注册写路由但未出现在 openapiDocument.paths");
  }

  // The other direction, and the reason `lockOnlyMutationRoutes` exists: the two
  // original sets only ever covered the routes somebody remembered to add, so a
  // brand-new write route could be mounted, undocumented and unclassified while
  // every assertion above still passed. Enumerating the registrations makes the
  // omission itself the failure.
  const declared = [...source.matchAll(new RegExp(ROUTER + "\\.(post|put|patch|delete)(?:<[^<>]*>)?\\(\\s*\"([^\"]+)\"", "g"))]
    .map((match) => match[2]!);
  assert.ok(declared.length > 0, "server.ts 应当至少注册一条写路由");
  // A regex over source cannot enumerate every way Fastify accepts a route, so
  // the guarantee is closed the other way: every *mounting token* must produce
  // exactly one parsed route. `app.route({...})` (spaces included),
  // `app["post"](...)`, a template path, a nested generic, a commented-out
  // handler — each breaks the equality. Extend the pattern above when this
  // fires; do not delete the check.
  const mountingTokens =
    source.match(new RegExp(
      ROUTER + "\\s*\\.\\s*(?:post|put|patch|delete)\\b|" +
      ROUTER + "\\s*\\.\\s*route\\b|" +
      ROUTER + "\\s*\\[\\s*[\"'`]\\w+[\"'`]\\s*\\]\\s*\\(",
      "g"
    )) ?? [];
  assert.equal(
    mountingTokens.length,
    declared.length,
    `server.ts 有 ${mountingTokens.length} 处写路由挂载，却只解析出 ${declared.length} 条：出现了本测试枚举不到的写法`
  );
  // Routes mounted anywhere else would be invisible to every assertion above,
  // and the app already uses `app.register` for plugins. The scan is recursive
  // because a route module would arrive as `src/routes/foo.ts`, not as a sibling,
  // and comments are dropped so documentation cannot trip it.
  const mountingPattern = new RegExp(
    ROUTER + "\\s*\\.\\s*(?:post|put|patch|delete|route)\\b|" +
    ROUTER + "\\s*\\[\\s*[\"'`]\\w+[\"'`]\\s*\\]\\s*\\("
  );
  for (const file of sourceFiles(new URL("../src/", import.meta.url))) {
    if (file.endsWith("/server.ts")) continue;
    assert.ok(
      !mountingPattern.test(stripComments(readFileSync(file, "utf8"))),
      file.slice(file.indexOf("src/")) + " 也挂载了写路由，本测试枚举不到它"
    );
  }
  const sets = { metadataOnly, databaseRequired, lockOnly };
  for (const url of declared) {
    const owners = Object.entries(sets).filter(([, urls]) => urls.includes(url)).map(([name]) => name);
    assert.equal(
      owners.length,
      1,
      url + " 必须恰好登记在 metadataOnly / databaseRequired / lockOnly 之一中，当前：" + (owners.join("+") || "未登记")
    );
  }
  for (const route of registered) {
    assert.ok(declared.includes(route), route + " 已登记但 server.ts 中没有对应的写路由注册点");
  }

  // The read-only week is deliberately absent from every registry, so it needs
  // its own assertion.
  assert.ok("/v1/mobile/workout-plan" in openapiDocument.paths);
  assert.ok(
    "requestBody" in openapiDocument.paths["/v1/mobile/workout-plan/generate"].post,
    "generate 路由必须声明 requestBody"
  );
});

test("a request that changes data is a route the router can see", () => {
  // Every guard above reasons about the *route table*, and the route table only
  // knows what was mounted through Fastify's route API. Two shapes therefore
  // slip past all of them while still changing data:
  //
  //   1. a write performed by a GET handler (the runtime check filters reads out
  //      by method, and the source scan only enumerates post/put/patch/delete);
  //   2. a write performed inside a hook (`addHook("onRequest", …)` short-circuits
  //      before any route matches, so `onRoute` never fires and the endpoint is
  //      absent from the dump the runtime check compares against).
  //   3. an object-form route (`app.route({ method: "GET", handler })`), which no
  //      `.get(`/`.put(` source scan ever visits;
  //   4. a lifecycle listener attached as `.on("request", …)` instead of
  //      `addHook` — Fastify runs both before route matching, so shape 2 applies
  //      to it unchanged.
  //
  // All four also bypass the mutation lock, which is taken in a `preHandler` hook
  // and released by the error/abort hooks. The shapes are asserted here as
  // source, because the route table cannot tell you what a handler body does.
  const WRITE = /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE)\b/i;
  const ROUTE_OPENER = new RegExp(ROUTER + "\\s*\\.\\s*(get|head|options)\\s*\\(");
  let scanned = 0;
  for (const file of sourceFiles(new URL("../src/", import.meta.url))) {
    const source = stripComments(readFileSync(file, "utf8"));
    const name = file.slice(file.indexOf("src/"));
    // The handler sits *inside* the argument list — `app.get("/x", async () => {…})`
    // — so the text to judge is the arguments, plus the body of any handler that
    // is named there and declared elsewhere in the same file. Reading the first
    // `{` after the closing bracket looked at the wrong block entirely: it passed
    // on every shape, which is how a write reached a GET handler unnoticed.
    const handlerText = (args: string): string => {
      let text = args;
      for (const match of args.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        const identifier = match[1]!;
        const declaration = new RegExp(
          "(?:const|let|var|function|async function)\\s+" + identifier + "\\b"
        ).exec(source);
        if (!declaration) continue;
        const paren = source.indexOf("(", declaration.index + declaration[0].length);
        const after = paren < 0 ? declaration.index + declaration[0].length : skipBalanced(source, paren);
        if (after < 0) continue;
        const open = source.indexOf("{", after);
        if (open >= 0) text += balancedBlock(source, open);
      }
      return text;
    };
    for (const call of source.matchAll(new RegExp(ROUTE_OPENER.source, "g"))) {
      const paren = call.index + call[0].length - 1;
      const close = skipBalanced(source, paren);
      if (close < 0) continue;
      scanned += 1;
      assert.ok(
        !WRITE.test(handlerText(source.slice(paren + 1, close))),
        `${name} 的 ${call[1]!.toUpperCase()} 处理器里出现写语句：写操作必须有可枚举的路由方法，否则它不在写路由登记表里，也拿不到变更锁`
      );
    }
    for (const hook of source.matchAll(/addHook\s*\(\s*"([^"]+)"/g)) {
      // The match ends on the closing quote of the event name, so the offset has
      // to be found rather than derived: `index + length - 1` sits on the `"`,
      // `skipBalanced` is handed a non-bracket and gives up, and the loop then
      // skipped every hook it was written to judge.
      const paren = source.indexOf("(", hook.index);
      if (paren < 0) continue;
      const close = skipBalanced(source, paren);
      if (close < 0) continue;
      assert.ok(
        !WRITE.test(handlerText(source.slice(paren + 1, close))),
        `${name} 的 ${hook[1]} 钩子里出现写语句：钩子型端点不经路由表，运行时转储看不到它，变更锁也不会被取`
      );
    }
    // Shape 3: `app.route({ method: "GET", handler })`. Only read methods are
    // judged — a write method here is a normal route and the other guards see it.
    for (const call of source.matchAll(new RegExp(ROUTER + "\\s*\\.\\s*route\\s*\\(", "g"))) {
      const paren = source.indexOf("(", call.index);
      if (paren < 0) continue;
      const close = skipBalanced(source, paren);
      if (close < 0) continue;
      const args = source.slice(paren + 1, close);
      const method = /method\s*:\s*"([A-Za-z]+)"/.exec(args)?.[1]?.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") continue;
      scanned += 1;
      assert.ok(
        !WRITE.test(handlerText(args)),
        `${name} 的 route({${method}}) 处理器里出现写语句：只有可枚举的路由方法才进写路由登记表，对象式声明的读路由同样绕不过这一条`
      );
    }
    // Shape 4: `.on("request", …)` and the rest of the request lifecycle. Fastify
    // runs these before matching, so a write here is invisible to the route table.
    for (const listener of source.matchAll(
      /\.on\s*\(\s*"(request|onRequest|preHandler|preValidation|preSerialization|onSend|onError|onResponse)"\s*,/g
    )) {
      const paren = source.indexOf("(", listener.index);
      if (paren < 0) continue;
      const close = skipBalanced(source, paren);
      if (close < 0) continue;
      assert.ok(
        !WRITE.test(handlerText(source.slice(paren + 1, close))),
        `${name} 的 ${listener[1]} 监听器里出现写语句：与 addHook 同类，它在路由匹配之前短路，转储和变更锁都看不到它`
      );
    }
  }
  assert.ok(scanned > 0, "src/ 下应当能解析出 GET 处理器，否则本测试空过");
});

test("the week editor offers neither today — nor a day already gone — as an editable row", () => {
  // Today's session is decided by the coach's recovery gate, not by the stored
  // plan, and the server marks every *past* day `rest/0` for every reader. A row
  // for either date shows a prescription the app never displays and takes an
  // edit that never lands. The week editor builds its own rows and nothing in
  // the type system connects them to that rule.
  //
  // The rule is asserted on the *set the row loop walks*, not on a name: a
  // property that keeps the name `editablePlanIndexes` while returning every
  // index passed the first version of this guard, which is exactly the edit a
  // later change would make. The rows are found by what they offer — a kind
  // picker or a distance field beside a date — so renaming the surrounding view
  // does not hide them either.
  const checked: string[] = [];
  for (const file of swiftSources()) {
    const source = readStripped(file);
    const name = file.slice(file.indexOf("RAI/"));
    for (const loop of source.matchAll(/ForEach\s*\(/g)) {
      const open = source.indexOf("{", loop.index + loop[0].length);
      if (open < 0) continue;
      const body = balancedBlock(source, open);
      if (!/localDate/.test(body)) continue;
      if (!/(?:Picker\s*\(|TextField\s*\()/.test(body)) continue;
      const argument = source.slice(loop.index + loop[0].length, open).split(",")[0]!.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
        const property = propertyBody(source, argument);
        assert.ok(property, `${name} 的可编辑行遍历 ${argument}，但同文件里找不到它的实现`);
        assert.ok(
          /guard\s+let\s+today[\s\S]*?else\s*\{[\s\S]*?return\s*\[\s*]/.test(property),
          `${name} 的 ${argument} 必须在取不到今日时返回空集：否则今天会重新变回可编辑行`
        );
        // Exactly one comparison, and it is `>`: `> today || == today` keeps the
        // substring `localDate > today` and puts today back in the list, and
        // `>= today` reads the same way to anyone skimming. Counting the
        // comparisons and reading the operator is what separates them.
        const comparisons = property.match(/localDate\s*[<>=!]+\s*today/g) ?? [];
        assert.equal(
          comparisons.length,
          1,
          `${name} 的 ${argument} 只有一处日期判定才可能只保留未来：实际 ${JSON.stringify(comparisons)}`
        );
        assert.equal(
          comparisons[0]!.replace(/\s+/g, ""),
          "localDate>today",
          `${name} 的 ${argument} 只能保留今天之后的日期：今天由恢复状态决定，过去日对任何读者都无效`
        );
        checked.push(`${name}:${argument}`);
        continue;
      }
      assert.ok(
        /localDate\s*>\s*today/.test(argument),
        `${name} 的可编辑行直接遍历 ${argument}：必须改由只保留“今天之后”的集合驱动`
      );
      checked.push(`${name}:inline`);
    }
  }
  // One skin ships a week editor. The floor is what stops a deleted or renamed
  // row loop from passing vacuously — it is 1 since the pixel skin was removed
  // on 2026-09-18, and 2 before that.
  assert.ok(checked.length >= 1, `今日页/计划页应当有可编辑的周计划行，实际找到 ${checked.length} 处`);
});

test("the plan editor cannot offer a session kind the API rejects", () => {
  // The goals editor listed 稳态跑 / `steady`, which `mobileWeekPlanItemSchema`
  // has never accepted — picking it made the save fail with HTTP 400. The editor
  // and the wire contract have no other link, so they are compared here.
  const accepted = mobileGoalsBodySchema.properties.weekPlan.items.properties.kind.enum as readonly string[];
  const editors = swiftSources();
  assert.ok(editors.length > 0, "apps/ios/RAI 下应当能找到 Swift 源文件");
  let pickers = 0;
  for (const file of editors) {
    const source = stripComments(readFileSync(file, "utf8"));
    // Any `.tag("<literal>")` participates, whatever the view builder and
    // whatever the literal's shape. A pattern that only accepted
    // `Text("..").tag("lower_case")` would quietly skip a picker written over
    // several lines — and a value the API has never heard of, say `Steady`,
    // instead of failing on it.
    const offered = [...source.matchAll(/\.tag\(\s*"([^"]*)"\s*\)/g)].map((match) => match[1]!);
    const name = file.slice(file.indexOf("RAI/"));
    // Every picker is checked on its own, not the file as a whole: a picker whose
    // options come from a variable — `ForEach(kinds) { … .tag($0) }` — parses to
    // nothing, and one literal picker elsewhere in the same file used to keep the
    // floor below green while the data-driven one offered whatever it liked.
    for (const picker of source.matchAll(/(?:^|[^A-Za-z0-9_])Picker\s*\(/g)) {
      // Skip the argument list before looking for the content block. `Picker(
      // selection: Binding(get: { … }, set: { … })) { … }` puts a closure inside
      // the arguments, and the first `{` after the call belongs to *that*
      // closure — so the tags were read out of an empty block and any selector
      // written that way was invisible to this scan.
      const paren = picker.index + picker[0].length - 1;
      const close = skipBalanced(source, paren);
      if (close < 0) continue;
      const open = source.indexOf("{", close);
      if (open < 0) continue;
      for (const tag of balancedBlock(source, open).matchAll(/\.tag\(\s*([^)]*)\)/g)) {
        const value = tag[1]!.trim();
        assert.ok(
          /^"[^"]*"$/.test(value),
          name + " 的选择器出现非字面量 tag(" + value + ")，本次扫描看不到它提供的选项；请改为字面量，或扩展本测试的扫描方式"
        );
      }
    }
    if (offered.length === 0) {
      // Skipping is what lets a selector drift: a `Picker` built from a variable
      // parses to nothing, and the remaining files keep the `pickers` floor green.
      assert.ok(
        !/(?:^|[^A-Za-z0-9_])Picker\s*\(/.test(source),
        name + " 含 Picker 却解析不出任何 .tag 字面量，请扩展本测试的扫描方式再改选择器"
      );
      continue;
    }
    pickers += 1;
    for (const kind of offered) {
      assert.ok(
        accepted.includes(kind),
        name + " 提供的 " + kind + " 不在服务端接受的范围 " + accepted.join("/") + " 内"
      );
    }
    assert.deepEqual(
      [...offered].sort(),
      [...accepted].sort(),
      name + " 的训练类型选项应与服务端一致（既不缺也不多）"
    );
  }
  // One skin ships a picker, and it is the only one left: the pixel skin was
  // deleted on 2026-09-18. The floor is what stops a deleted or renamed picker
  // from passing vacuously — bump it when another skin gains one.
  assert.ok(pickers >= 1, "应当有一个训练类型选择器，实际扫描到 " + pickers + " 个");
});
