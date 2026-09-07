import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  importJobBodySchema,
  importSourceBodySchema,
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
