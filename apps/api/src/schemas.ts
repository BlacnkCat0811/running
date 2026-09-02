const identifier = { type: "string", minLength: 1, maxLength: 160 } as const;

export const identifierParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: identifier }
} as const;

export const backupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 8, maxLength: 240, pattern: "^[^/\\\\]+\\.sqlite$" }
  }
} as const;

export const workoutListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    offset: { type: "string", pattern: "^[0-9]{1,9}$" },
    status: { type: "string", enum: ["eligible", "trial", "excluded"] },
    sessionType: {
      type: "string",
      enum: ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"]
    },
    stimulusType: {
      type: "string",
      enum: ["recovery", "aerobic_base", "marathon_pace", "lactate_threshold", "vo2max", "anaerobic_endurance", "unclassified"]
    },
    participation: { type: "string", enum: ["included", "not_included"] },
    environment: { type: "string", enum: ["outdoor", "indoor", "unknown"] },
    days: { type: "string", enum: ["28", "90", "365", "4000"] },
    sourceGroup: { type: "string", enum: ["apple_watch", "third_party", "manual"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    route: { type: "string", enum: ["available", "missing"] }
  }
} as const;

export const trendQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

export const trainingStatisticsHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["granularity"],
  properties: {
    granularity: { type: "string", enum: ["week", "month", "year"] },
    limit: { type: "string", pattern: "^[0-9]{1,3}$" }
  }
} as const;

export const trainingLoadQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

export const trainingZonesHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "string", pattern: "^[0-9]{1,4}$" } }
} as const;

export const mobileGoalsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["weeklyDistanceKm"],
  properties: {
    weeklyDistanceKm: { type: "number", minimum: 1, maximum: 500 }
  }
} as const;

const automaticOrManualNumber = (minimum: number, maximum: number, valueName: string) => ({
  oneOf: [
    {
      type: "object" as const,
      additionalProperties: false,
      required: ["mode", valueName],
      properties: {
        mode: { const: "auto" },
        [valueName]: { type: "null" as const }
      }
    },
    {
      type: "object" as const,
      additionalProperties: false,
      required: ["mode", valueName],
      properties: {
        mode: { const: "manual" },
        [valueName]: { type: "number" as const, minimum, maximum }
      }
    }
  ]
});

export const trainingZoneProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "restingHeartRate", "maximumHeartRate", "lactateThresholdPace"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    restingHeartRate: automaticOrManualNumber(35, 110, "valueBpm"),
    maximumHeartRate: automaticOrManualNumber(120, 230, "valueBpm"),
    lactateThresholdPace: automaticOrManualNumber(150, 900, "valueSecondsPerKm")
  }
} as const;

export const predictionQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    temperatureC: { type: "number", minimum: -40, maximum: 60 },
    humidityPercent: { type: "number", minimum: 0, maximum: 100 },
    elevationGain5k: { type: "number", minimum: 0, maximum: 10000 },
    elevationGain10k: { type: "number", minimum: 0, maximum: 10000 },
    elevationGainHalfMarathon: { type: "number", minimum: 0, maximum: 10000 }
  }
} as const;

export const predictionModelTrainBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    asOf: {
      type: "string",
      format: "date-time",
      minLength: 20,
      maxLength: 35,
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
    }
  }
} as const;

export const predictionModelIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: {
      type: "string",
      pattern: "^prediction_model_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  }
} as const;

export const modelComparisonQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["base", "candidate"],
  properties: { base: identifier, candidate: identifier }
} as const;

export const overrideBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["eligibilityOverride", "statisticsParticipation", "sessionType", "performanceProtocol", "rpe", "conditionTags", "note"],
  properties: {
    eligibilityOverride: { anyOf: [{ type: "string", enum: ["include", "exclude"] }, { type: "null" }] },
    statisticsParticipation: { anyOf: [{ type: "string", enum: ["include", "exclude"] }, { type: "null" }] },
    sessionType: {
      anyOf: [
        { type: "string", enum: ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"] },
        { type: "null" }
      ]
    },
    performanceProtocol: {
      anyOf: [
        {
          type: "string",
          enum: [
            "five_k_time_trial",
            "ten_k_time_trial",
            "thirty_min_threshold",
            "half_marathon_race",
            "other_race"
          ]
        },
        { type: "null" }
      ]
    },
    rpe: { anyOf: [{ type: "integer", minimum: 1, maximum: 10 }, { type: "null" }] },
    conditionTags: {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 80 }
    },
    note: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] }
  }
} as const;

export const importSourceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId"],
  properties: {
    sourceId: { type: "string", minLength: 1, maxLength: 160 }
  }
} as const;

export const importJobBodySchema = {
  ...importSourceBodySchema
} as const;

export const deleteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: { confirmation: { type: "string", maxLength: 40 } }
} as const;

export const restoreBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: { confirmation: { type: "string", maxLength: 40 } }
} as const;

const objectSchema = (...required: string[]) => ({
  type: "object" as const,
  additionalProperties: true,
  required,
  properties: Object.fromEntries(required.map((name) => [name, {}]))
});
const arraySchema = (...required: string[]) => ({
  type: "array" as const,
  items: objectSchema(...required)
});
const importJobSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "importMode", "insertedWorkouts", "updatedWorkouts", "removedWorkouts", "unchangedWorkouts",
    "routesUpdated", "featuresReused", "featuresRecomputed", "modelReplayFrom", "durationMs", "backupName"
  ],
  properties: {
    importMode: { type: "string", enum: ["unchanged", "incremental", "full"] },
    insertedWorkouts: { type: "integer" },
    updatedWorkouts: { type: "integer" },
    removedWorkouts: { type: "integer" },
    unchangedWorkouts: { type: "integer" },
    routesUpdated: { type: "integer" },
    featuresReused: { type: "integer" },
    featuresRecomputed: { type: "integer" },
    modelReplayFrom: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    durationMs: { type: "number", minimum: 0 },
    backupName: { anyOf: [{ type: "string" }, { type: "null" }] }
  }
} as const;
const importJobResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "phase", "message", "createdAt", "completedAt", "error"],
  properties: {
    id: { type: "string" },
    sourceId: { type: "string" },
    status: { type: "string" },
    phase: { type: "string" },
    message: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    completedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
    progress: { type: "number", minimum: 0, maximum: 1 },
    summary: importJobSummarySchema
  }
} as const;
const successSchema = (summary: string): Record<string, unknown> => {
  const objects: Record<string, string[]> = {
    "OpenAPI 3.1 契约": ["openapi", "info", "paths"],
    "本地服务健康状态": ["status", "databaseReady", "localOnly", "now"],
    "概览数据": ["generatedAt", "totals"],
    "SQLite 数据资产摘要": ["datasetVersion", "issues"],
    "导入、canonical 与特征质量审计": ["generatedAt", "canonical"],
    "导出移除路线与健康时序的本地诊断 JSON": ["generatedAt", "privacy"],
    "全局导入与重算状态": ["databaseReady", "busy", "recomputeJob", "importJob"],
    "分页训练列表": ["items", "total", "limit", "offset"],
    "训练详情": ["workout", "dimensions"],
    "训练内时间序列": ["trainingSessionId", "series"],
    "追加训练覆盖 revision 并重算": ["overrideId", "jobId"],
    "CA、TA、Decay 与 GV 趋势": ["startDate", "endDate", "daily", "workouts"],
    "当前周、月、年及滚动负荷摘要": ["generatedAt", "week", "month", "year"],
    "周、月、年训练统计历史": ["generatedAt", "granularity", "periods"],
    "每日训练负荷与状态时间线": ["generatedAt", "days"],
    "今日心率与配速分区": ["generatedAt", "profile", "settings"],
    "历史心率与配速分区": ["generatedAt", "profiles"],
    "更新心率与配速分区设置": ["revision", "effectiveFromLocalDate"],
    "VO₂max、乳酸阈值与比赛成绩预测": ["reportVersion", "generatedAt", "snapshot"],
    "CatBoost 预测模型运行历史": ["runs"],
    "预测模型运行详情与阶段事件": ["run", "events"],
    "创建 CatBoost 训练任务；通过离线门槛后直接激活": ["runId", "status"],
    "回滚并激活验证成功的历史预测模型": ["activePredictionModelRunId"],
    "取消预测模型训练任务": ["cancelRequested", "status"],
    "量化比较两个不可变模型运行": ["base", "candidate", "metrics"],
    "创建完整重算任务": ["jobId"],
    "激活成功的历史模型运行": ["activeModelRunId"],
    "任务与阶段事件": ["id", "status", "events"],
    "请求取消任务": ["cancelRequested", "status"],
    "从已检查的 Apple Health 来源导入": ["id", "status", "phase", "message"],
    "导入任务状态": ["id", "status", "phase", "message"],
    "最近的导入任务": ["id", "status", "phase", "message"],
    "流式上传并安全解压 Apple Health ZIP": ["sourceId", "uploadId", "fileName", "sizeBytes"],
    "预检已上传或本机导入来源": ["sourceId", "status", "exportFileName", "routeFileCount"],
    "发现常用目录中的 Apple Health 导出": ["sources"],
    "最近成功使用的导入来源": ["sources"],
    "创建 SQLite 在线备份": ["name", "sizeBytes", "createdAt"],
    "校验并原子恢复本地 SQLite 备份": ["restored", "restoredBackup", "safetyBackup"],
    "备份后删除当前本地数据库": ["deleted", "preservation"]
  };
  const arrays: Record<string, string[]> = {
    "模型运行历史": ["id", "status"],
    "重算任务历史": ["id", "status"],
    "本地备份列表": ["name", "sizeBytes", "createdAt"]
  };
  if (summary === "当前运行中的导入任务" || summary === "最近的导入任务") {
    return { anyOf: [{ $ref: "#/components/schemas/ImportJobResponse" }, { type: "null" }] };
  }
  if (summary === "从已检查的 Apple Health 来源导入" || summary === "导入任务状态") {
    return { $ref: "#/components/schemas/ImportJobResponse" };
  }
  const arrayFields = arrays[summary];
  if (arrayFields) return arraySchema(...arrayFields);
  return objectSchema(...(objects[summary] ?? ["message"]));
};
const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } }
});
const errorResponse = {
  description: "请求无效或资源状态冲突",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
};
const responses = (summary: string, description = "成功") => ({
  "200": jsonResponse(description, successSchema(summary)),
  "400": errorResponse,
  "403": errorResponse,
  "404": errorResponse,
  "409": errorResponse,
  "413": errorResponse,
  "415": errorResponse,
  "422": errorResponse
});
const operation = (
  tags: string[],
  summary: string,
  extras: Record<string, unknown> = {}
) => ({ tags, summary, responses: responses(summary), ...extras });
const pathId = [{
  name: "id", in: "path", required: true,
  schema: identifier,
  description: "资源标识符"
}];
const body = (schema: unknown, description: string) => ({
  required: true,
  description,
  content: { "application/json": { schema } }
});

export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "RAI Local API",
    version: "0.1.0",
    description: "仅监听 127.0.0.1 的单用户跑步能力分析 API。评分结果全部来自 SQLite active 视图。"
  },
  servers: [{ url: "http://127.0.0.1:8787", description: "本机" }],
  tags: [
    { name: "Read", description: "active 数据读取" },
    { name: "Workouts", description: "训练与用户覆盖" },
    { name: "Jobs", description: "导入和重算" },
    { name: "Maintenance", description: "本地备份与删除" }
  ],
  components: {
    schemas: {
      Error: {
        type: "object", required: ["message"], additionalProperties: true,
        properties: { code: { type: "string" }, message: { type: "string" } }
      },
      ImportJobRequest: importJobBodySchema,
      ImportJobResponse: importJobResponseSchema,
      WorkoutOverride: overrideBodySchema,
      TrainingZoneProfileUpdate: trainingZoneProfileBodySchema,
      PredictionModelTrainRequest: predictionModelTrainBodySchema,
      DeleteDatabaseRequest: deleteBodySchema,
      RestoreBackupRequest: restoreBodySchema,
      MobileGoalsUpdate: mobileGoalsBodySchema
    }
  },
  paths: {
    "/v1/openapi.json": { get: operation(["Read"], "OpenAPI 3.1 契约") },
    "/v1/health": { get: operation(["Read"], "本地服务健康状态") },
    "/v1/dashboard": { get: operation(["Read"], "概览数据") },
    "/v1/data-summary": { get: operation(["Read"], "SQLite 数据资产摘要") },
    "/v1/data-audit": { get: operation(["Read"], "导入、canonical 与特征质量审计") },
    "/v1/diagnostics": { get: operation(["Maintenance"], "导出移除路线与健康时序的本地诊断 JSON") },
    "/v1/runtime-status": { get: operation(["Jobs"], "全局导入与重算状态") },
    "/v1/workouts": { get: operation(["Workouts"], "分页训练列表", {
      parameters: Object.entries(workoutListQuerySchema.properties).map(([name, schema]) => ({
        name, in: "query", required: false, schema
      }))
    }) },
    "/v1/workouts/{id}": { get: operation(["Workouts"], "训练详情", { parameters: pathId }) },
    "/v1/workouts/{id}/series": { get: operation(["Workouts"], "训练内时间序列", { parameters: pathId }) },
    "/v1/workouts/{id}/override": { patch: operation(["Workouts"], "追加训练覆盖 revision 并重算", {
      parameters: pathId,
      requestBody: body({ $ref: "#/components/schemas/WorkoutOverride" }, "完整的训练覆盖字段")
    }) },
    "/v1/trends": { get: operation(["Read"], "CA、TA、Decay 与 GV 趋势", {
      parameters: [{ name: "days", in: "query", schema: trendQuerySchema.properties.days }]
    }) },
    "/v1/training-statistics/overview": { get: operation(["Read"], "当前周、月、年及滚动负荷摘要") },
    "/v1/training-statistics/history": { get: operation(["Read"], "周、月、年训练统计历史", {
      parameters: [
        { name: "granularity", in: "query", required: true, schema: trainingStatisticsHistoryQuerySchema.properties.granularity },
        { name: "limit", in: "query", schema: trainingStatisticsHistoryQuerySchema.properties.limit }
      ]
    }) },
    "/v1/training-statistics/load": { get: operation(["Read"], "每日训练负荷与状态时间线", {
      parameters: [{ name: "days", in: "query", schema: trainingLoadQuerySchema.properties.days }]
    }) },
    "/v1/training-zones/current": { get: operation(["Read"], "今日心率与配速分区") },
    "/v1/mobile/today": { get: operation(["Read"], "iOS 首页聚合：今日汇总、周进度、本周每日里程与最近训练") },
    "/v1/mobile/statistics": { get: operation(["Read"], "iOS 统计页聚合：近 3 月分运动类型里程、滚动汇总与心率区间分布") },
    "/v1/mobile/trends": { get: operation(["Read"], "iOS 趋势页聚合：12 周跑量、四周增幅、个人纪录与洞察") },
    "/v1/mobile/goals": {
      get: operation(["Read"], "读取 iOS 周目标"),
      put: operation(["Workouts"], "更新 iOS 周目标", {
        requestBody: body({ $ref: "#/components/schemas/MobileGoalsUpdate" }, "周跑量目标（公里）")
      })
    },
    "/v1/training-zones/history": { get: operation(["Read"], "历史心率与配速分区", {
      parameters: [{ name: "days", in: "query", schema: trainingZonesHistoryQuerySchema.properties.days }]
    }) },
    "/v1/training-zones/profile": { patch: operation(["Workouts"], "更新心率与配速分区设置", {
      requestBody: body({ $ref: "#/components/schemas/TrainingZoneProfileUpdate" }, "完整设置与当前 revision")
    }) },
    "/v1/predictions": { get: operation(["Read"], "VO₂max、乳酸阈值与比赛成绩预测", {
      parameters: Object.entries(predictionQuerySchema.properties).map(([name, schema]) => ({ name, in: "query", schema }))
    }) },
    "/v1/prediction-models": {
      get: operation(["Read"], "CatBoost 预测模型运行历史")
    },
    "/v1/prediction-models/train": {
      post: operation(["Jobs"], "创建 CatBoost 训练任务；通过离线门槛后直接激活", {
        requestBody: body({ $ref: "#/components/schemas/PredictionModelTrainRequest" }, "可选的训练数据截止时间")
      })
    },
    "/v1/prediction-models/{id}": {
      get: operation(["Read"], "预测模型运行详情与阶段事件", { parameters: pathId })
    },
    "/v1/prediction-models/{id}/activate": {
      post: operation(["Jobs"], "回滚并激活验证成功的历史预测模型", { parameters: pathId })
    },
    "/v1/prediction-models/{id}/cancel": {
      post: operation(["Jobs"], "取消预测模型训练任务", { parameters: pathId })
    },
    "/v1/model-runs": {
      get: operation(["Read"], "模型运行历史"),
      post: operation(["Jobs"], "创建完整重算任务")
    },
    "/v1/model-runs/compare": { get: operation(["Read"], "量化比较两个不可变模型运行", {
      parameters: [
        { name: "base", in: "query", required: true, schema: identifier },
        { name: "candidate", in: "query", required: true, schema: identifier }
      ]
    }) },
    "/v1/model-runs/{id}/activate": { post: operation(["Jobs"], "激活成功的历史模型运行", { parameters: pathId }) },
    "/v1/jobs": { get: operation(["Jobs"], "重算任务历史") },
    "/v1/jobs/{id}": { get: operation(["Jobs"], "任务与阶段事件", { parameters: pathId }) },
    "/v1/jobs/{id}/cancel": { post: operation(["Jobs"], "请求取消任务", { parameters: pathId }) },
    "/v1/import-jobs": { post: operation(["Jobs"], "从已检查的 Apple Health 来源导入", {
      requestBody: body({ $ref: "#/components/schemas/ImportJobRequest" }, "已预检的导入来源标识")
    }) },
    "/v1/import-jobs/{id}": { get: operation(["Jobs"], "导入任务状态", { parameters: pathId }) },
    "/v1/import-jobs/active": { get: operation(["Jobs"], "当前运行中的导入任务") },
    "/v1/import-jobs/latest": { get: operation(["Jobs"], "最近的导入任务") },
    "/v1/imports/uploads": { post: operation(["Jobs"], "流式上传并安全解压 Apple Health ZIP", {
      requestBody: { required: true, content: { "multipart/form-data": { schema: {
        type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } }
      } } } },
      responses: {
        ...responses("流式上传并安全解压 Apple Health ZIP"),
        "429": errorResponse,
        "507": errorResponse
      }
    }) },
    "/v1/imports/inspect": { post: operation(["Jobs"], "预检已上传或本机导入来源", {
      requestBody: body(importSourceBodySchema, "待预检的来源")
    }) },
    "/v1/import-sources/{id}": { delete: operation(["Jobs"], "清理保留的失败上传来源", {
      parameters: pathId
    }) },
    "/v1/import-sources/discover": { post: operation(["Jobs"], "发现常用目录中的 Apple Health 导出") },
    "/v1/import-sources/recent": { get: operation(["Jobs"], "最近成功使用的导入来源") },
    "/v1/backups": {
      get: operation(["Maintenance"], "本地备份列表"),
      post: operation(["Maintenance"], "创建 SQLite 在线备份")
    },
    "/v1/backups/{name}": {
      get: operation(["Maintenance"], "下载本地 SQLite 备份", {
        parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }],
        responses: { "200": { description: "SQLite 备份", content: { "application/x-sqlite3": { schema: { type: "string", format: "binary" } } } }, "404": errorResponse }
      }),
      delete: operation(["Maintenance"], "删除指定的本地 SQLite 备份", {
        parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }]
      })
    },
    "/v1/backups/{name}/restore": { post: operation(["Maintenance"], "校验并原子恢复本地 SQLite 备份", {
      parameters: [{ name: "name", in: "path", required: true, schema: backupParamsSchema.properties.name }],
      requestBody: body({ $ref: "#/components/schemas/RestoreBackupRequest" }, "恢复确认文字")
    }) },
    "/v1/database": { delete: operation(["Maintenance"], "备份后删除当前本地数据库", {
      requestBody: body({ $ref: "#/components/schemas/DeleteDatabaseRequest" }, "删除确认文字"),
      responses: {
        ...responses("备份后删除当前本地数据库"),
        "200": jsonResponse("数据库已删除，原始数据已保存", {
          type: "object",
          required: ["deleted", "preservation"],
          properties: {
            deleted: { const: true },
            preservation: {
              oneOf: [
                {
                  type: "object", required: ["kind", "backup"], additionalProperties: false,
                  properties: {
                    kind: { const: "backup" },
                    backup: objectSchema("name", "sizeBytes", "createdAt")
                  }
                },
                {
                  type: "object", required: ["kind", "snapshot"], additionalProperties: false,
                  properties: {
                    kind: { const: "quarantine" },
                    snapshot: objectSchema("name", "sizeBytes", "createdAt")
                  }
                }
              ]
            }
          }
        })
      }
    }) }
  }
} as const;
