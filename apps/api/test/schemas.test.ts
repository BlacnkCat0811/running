import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Fastify from "fastify";

import {
  importJobBodySchema,
  importSourceBodySchema,
  mobileGoalsBodySchema,
  openapiDocument,
  overrideBodySchema,
  predictionModelIdParamsSchema,
  predictionModelTrainBodySchema,
  recoveryTrendQuerySchema,
  runCoachCommandSchema,
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
  assert.ok("performance" in importJobSchema.properties);
  assert.deepEqual(importJobSchema.properties.performance.required, ["validationMode", "totalMs", "stagesMs"]);
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

  // Enumerate every mounted route module, not only the bootstrap file.
  const declared: string[] = [];
  for (const file of sourceFiles(new URL("../src/", import.meta.url))) {
    const text = stripComments(readFileSync(file, "utf8"));
    const routes = [...text.matchAll(new RegExp(ROUTER + "\\.(post|put|patch|delete)(?:<[^<>]*>)?\\(\\s*\"([^\"]+)\"", "g"))]
      .map((match) => match[2]!);
    const tokens = text.match(new RegExp(ROUTER + "\\s*\\.\\s*(?:post|put|patch|delete|route)\\b|" + ROUTER + "\\s*\\[\\s*[\"'`]\\w+[\"'`]\\s*\\]\\s*\\(", "g")) ?? [];
    assert.equal(tokens.length, routes.length, `${file}: unparsed route registration`);
    declared.push(...routes);
  }
  assert.ok(declared.length > 0);
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
  const previewOperation = openapiDocument.paths["/v1/mobile/workout-plan/preview"].post;
  assert.ok("requestBody" in previewOperation);
  const previewSchema = (previewOperation.requestBody as {
    content: { "application/json": { schema: { required?: string[] } } }
  }).content["application/json"].schema;
  assert.deepEqual(previewSchema.required, ["expectedRevision"]);
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
    const normalizedFile = file.replace(/\\/g, "/");
    const name = normalizedFile.slice(normalizedFile.indexOf("RAI/"));
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

test("native session and race pickers exactly match their API contracts", () => {
  const sessionKinds = mobileGoalsBodySchema.properties.weekPlan.items.properties.kind.enum;
  const raceDistances = mobileGoalsBodySchema.properties.raceTarget.anyOf[0].properties.distance.enum;
  let sessionPickers = 0;
  let racePickers = 0;
  let coachPickers = 0;
  for (const file of swiftSources()) {
    const source = stripComments(readFileSync(file, "utf8"));
    const normalizedFile = file.replace(/\\/g, "/");
    const name = normalizedFile.slice(normalizedFile.indexOf("RAI/"));
    for (const picker of source.matchAll(/(?:^|[^A-Za-z0-9_])Picker\s*\(/g)) {
      // Parse each picker independently; DatePicker and argument closures are not options.
      const paren = picker.index + picker[0].length - 1;
      const close = skipBalanced(source, paren);
      assert.ok(close >= 0, name + " 的 Picker 参数无法解析");
      const args = source.slice(paren, close);
      // Local reminder hours are not an API enum. Still pin the offered quiet-hour range.
      if (name.endsWith("TechTrainingReminderView.swift") && args.includes('"提醒时间"')) {
        assert.match(balancedBlock(source, source.indexOf("{", close)), /ForEach\(7\.\.\.21/);
        continue;
      }
      if (name.endsWith("TechWorkoutFeedbackView.swift")) {
        const options = balancedBlock(source, source.indexOf("{", close));
        if (args.includes('"训练类型"')) {
          const kinds = /ForEach\(\[([^\]]+)\]/.exec(options)?.[1];
          assert.ok(kinds, "feedback session picker must offer the contract list");
          const actual = [...kinds.matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
          assert.deepEqual(actual, [...overrideBodySchema.properties.sessionType.anyOf[0].enum].sort());
          assert.match(options, /String\?\.none/);
          assert.match(options, /tag\(Optional\(\$0\)\)/);
        } else {
          assert.ok(args.includes("title, selection: selection"), "unexpected feedback picker");
          const values = [...options.matchAll(/tag\(Optional\("([^"]+)"\)\)/g)].map(match => match[1]).sort();
          assert.deepEqual(values, [...overrideBodySchema.properties.eligibilityOverride.anyOf[0].enum].sort());
          assert.deepEqual(values, [...overrideBodySchema.properties.statisticsParticipation.anyOf[0].enum].sort());
          assert.match(options, /String\?\.none/);
        }
        continue;
      }
      if (name.endsWith("TechRunCoachSetup.swift")) {
        const options = balancedBlock(source, source.indexOf("{", close));
        const tags = [...options.matchAll(/\.tag\(\s*([^)]*)\)/g)].map(match => match[1]!.trim());
        const config = runCoachCommandSchema.properties.config.properties;
        if (args.includes('"目标"') || args.includes('"强度目标"')) {
          const values = tags.map(value => JSON.parse(value) as string).sort();
          const accepted = args.includes('"目标"') ? config.goal.enum : config.targetType.enum;
          assert.deepEqual(values, [...accepted].sort(), name + " 的教练偏好必须与 API 契约一致");
        } else {
          assert.ok(args.includes('"比赛距离"'), name + " 出现未登记的教练 Picker");
          assert.deepEqual(tags.map(Number), [5, 10, 21.0975, 42.195, -1]);
          assert.match(source, /distance == -1 \? Double\(customDistance\)/);
          assert.match(source, /km >= 1\.6 && km <= 1609\.344/);
          assert.equal(config.raceDistanceKm.anyOf[0].minimum, 1.6);
          assert.equal(config.raceDistanceKm.anyOf[0].maximum, 1609.344);
        }
        coachPickers += 1;
        continue;
      }
      const isRace = args.includes('"比赛距离"');
      const isInputMode = args.includes('"目标输入方式"');
      assert.ok(isRace || isInputMode || args.includes('"训练类型"'), name + " 出现未登记的 Picker，请补充对应 API 契约扫描");
      const accepted = isInputMode ? ["pace", "finish"] : isRace ? raceDistances : sessionKinds;
      const open = source.indexOf("{", close);
      assert.ok(open >= 0, name + " 的 Picker 缺少选项块");
      const offered: string[] = [];
      for (const tag of balancedBlock(source, open).matchAll(/\.tag\(\s*([^)]*)\)/g)) {
        const value = tag[1]!.trim();
        assert.ok(/^"[^"]*"$/.test(value), name + " 的 tag 必须是可验证的字面量：" + value);
        offered.push(value.slice(1, -1));
      }
      assert.deepEqual([...offered].sort(), [...accepted].sort(), name + " 的选项必须与 API 契约一致");
      if (isRace) racePickers += 1;
      else if (!isInputMode) sessionPickers += 1;
    }
  }
  assert.ok(sessionPickers >= 1, "必须保留训练类型选择器");
  assert.ok(racePickers >= 1, "必须保留比赛距离选择器");
  assert.equal(coachPickers, 3, "教练目标、比赛距离和强度目标必须分别扫描，不能因跳过新页面而空转");
});
