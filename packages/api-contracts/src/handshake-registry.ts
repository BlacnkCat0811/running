/**
 * Registry of every top-level `/v1/handshake` key (PR-05, 2026-10-21).
 *
 * The handshake is the only place where a client learns "which contracts does
 * this server understand". Its keys used to be added ad hoc on the server and
 * mirrored by hand in Swift, which is how `factsAnalysisViewContractVersion`
 * ended up advertised but not mirrored. This registry does not replace the
 * TypeScript interface or the Swift DTO; it is the reviewable inventory that a
 * gate can compare against both.
 *
 * `consumer` is intentionally explicit. "deferred" means the field is decoded
 * but no production branch reads it yet — a field that exists only to satisfy a
 * shape is not a capability promise, and must say so.
 */
export interface HandshakeKeyRegistration {
  readonly key: string;
  readonly kind: "identity" | "capability" | "parameter";
  /** Version value the current server advertises, when the key is a capability. */
  readonly version?: number;
  readonly semantics: string;
  readonly advertisedWhen: string;
  readonly consumer: string;
  readonly whenAbsent: string;
}

export const HANDSHAKE_KEY_REGISTRY = [
  {
    key: "serverId", kind: "identity",
    semantics: "服务实例身份（与 athleteId/datasetEpoch 组成数据域）",
    advertisedWhen: "总是", consumer: "API + iOS + 客户端缓存作用域",
    whenAbsent: "不是可选键；缺失即协议错误"
  },
  {
    key: "athleteId", kind: "identity",
    semantics: "运动员身份",
    advertisedWhen: "总是", consumer: "API + iOS + 客户端缓存作用域",
    whenAbsent: "不是可选键；缺失即协议错误"
  },
  {
    key: "datasetEpoch", kind: "identity",
    semantics: "数据集代（恢复/换库后变化）",
    advertisedWhen: "总是", consumer: "API + iOS 作用域/缓存失效",
    whenAbsent: "不是可选键；缺失即协议错误"
  },
  {
    key: "syncProtocolVersion", kind: "capability", version: 1,
    semantics: "同步身份主版本",
    advertisedWhen: "总是", consumer: "iOS 连接兼容性提示",
    whenAbsent: "不是可选键；旧客户端按不兼容处理"
  },
  {
    key: "apiVersion", kind: "capability", version: 1,
    semantics: "路由族版本标签",
    advertisedWhen: "总是", consumer: "iOS 展示/诊断",
    whenAbsent: "不是可选键"
  },
  {
    key: "healthKitRecordSyncVersion", kind: "capability", version: 2,
    semantics: "类型作用域 UUID 删除的 v2 记录同步",
    advertisedWhen: "服务支持 v2 记录同步时",
    consumer: "iOS 直连同步",
    whenAbsent: "按 v1 记录同步处理"
  },
  {
    key: "planReceiptMetadata", kind: "capability",
    semantics: "旧回执接受 UUID/时间/幂等/导出元数据",
    advertisedWhen: "服务支持扩展回执字段时",
    consumer: "iOS legacy 回执形状选择",
    whenAbsent: "只发送 legacy 最小回执"
  },
  {
    key: "planSnapshotContractVersion", kind: "capability", version: 1,
    semantics: "v1 聚合计划快照 `/v1/mobile/training-plan-state`",
    advertisedWhen: "非 coach-loop 托管的数据域",
    consumer: "iOS TrainingPlanStore 聚合读",
    whenAbsent: "不回退到该读；managed 走 coach-loop，未迁移走 typed 错误"
  },
  {
    key: "trainingPlanContractVersion", kind: "capability", version: 2,
    semantics: "统一训练读合同（`X-RAI-Training-Contract: 2`）",
    advertisedWhen: "非托管数据域；或已迁移且 owner-ready 的 managed 数据域",
    consumer: "iOS 读写能力分离 + `planWritesAvailable`",
    whenAbsent: "客户端不得请求 v2 统一读；按未支持/只读处理"
  },
  {
    key: "trainingPlanCommandContractVersion", kind: "capability", version: 2,
    semantics: "统一训练写命令合同（`/training-plan/commands*`）",
    advertisedWhen: "独立模式 validation/production 已显式启用、owner-ready，且客户端发送 X-RAI-Client-Training-Commands: 2；默认关闭，实际生产启用随部署单独核查",
    consumer: "iOS TrainingPlanPublisher（阶段 5）",
    whenAbsent: "只读；命令路由也拒绝新的写；不得回退到已退役的旧写面"
  },
  {
    key: "trainingPlanSessionContractVersion", kind: "capability", version: 1,
    semantics: "统一读 2 的稳定课程/保护扩展（X-RAI-Training-Sessions: 1）",
    advertisedWhen: "B03/G1 起：已完成受控身份迁移（schema 2）且 owner-ready 的 scope；B01/B02 不宣告",
    consumer: "iOS 精确能力判定；课程 DTO 消费自 B02，保护只读展示自 B03",
    whenAbsent: "无课程实体能力；不以日期/hash 伪造 ID，不回流旧写面"
  },
  {
    key: "trainingPlanSessionCommandContractVersion", kind: "capability", version: 1,
    semantics: "独立课程 preview/submit（X-RAI-Client-Training-Session-Commands: 1）",
    advertisedWhen: "schema 2、owner-ready、publication 1，独立模式 validation/production 已启用且精确协商 X-RAI-Client-Training-Session-Commands: 1",
    consumer: "iOS 精确能力判定、原生课程编辑与 TrainingPlanPublisher",
    whenAbsent: "课程只读；仍可查询原 operation，不改发配置 refresh 或旧 URL"
  },
  {
    key: "trainingPlanSessionDistanceOmissionContractVersion", kind: "capability", version: 1,
    semantics: "add/edit 省略距离由服务端保留或测量，不由课程命令 1 推导",
    advertisedWhen: "课程命令 1 可用且同请求精确协商 X-RAI-Client-Training-Session-Distance-Omission: 1",
    consumer: "iOS 课程编辑器与重放准入",
    whenAbsent: "发送显式合法距离/null；无法表达的 mixed 内容变更提示升级，不猜测剂量"
  },
  {
    key: "trainingPlanExecutionCommandContractVersion", kind: "capability", version: 1,
    semantics: "课程关联确认/纠错/撤回/明确跳过（X-RAI-Client-Training-Execution-Commands: 1）",
    advertisedWhen: "schema 2、owner-ready、publication 1，独立模式 validation/production 已启用且精确协商 X-RAI-Client-Training-Execution-Commands: 1",
    consumer: "iOS 精确能力判定、原生执行关联/回顾与 TrainingPlanPublisher",
    whenAbsent: "关联只读，不把同日观测当可靠完成"
  },
  {
    key: "trainingPlanUpdateContractVersion", kind: "capability", version: 1,
    semantics: "统一读 2 的事实/分析/关联/计划四阶段（X-RAI-Training-Updates: 1）",
    advertisedWhen: "B01 不宣告；G3 后 B08 实现验收，不等同于开启自动发布",
    consumer: "iOS 精确能力判定；阶段视图消费 deferred 至 B08",
    whenAbsent: "更新阶段未知；不能由同步成功推导计划已更新"
  },
  {
    key: "coachLoopContractVersion", kind: "capability", version: 1,
    semantics: "教练闭环聚合与命令合同",
    advertisedWhen: "服务支持 coach-loop 时",
    consumer: "iOS 统一训练页 + TrainingPlanStore",
    whenAbsent: "不展示统一页，不猜测写能力"
  },
  {
    key: "planPublicationContractVersion", kind: "capability", version: 1,
    semantics: "控制库持久发布操作（operationId 查询/重放）",
    advertisedWhen: "控制库支持持久操作时",
    consumer: "iOS pendingPlanPublication 幂等账目",
    whenAbsent: "不做持久操作账目；不得把查不到当 notFound 重放"
  },
  {
    key: "planReceiptContractVersion", kind: "capability", version: 2,
    semantics: "v2 回执（独立版本，不复用 planReceiptMetadata）",
    advertisedWhen: "服务支持 v2 回执时",
    consumer: "iOS 回执行编码",
    whenAbsent: "按 legacy 回执形状处理"
  },
  {
    key: "factsAnalysisContractVersion", kind: "capability", version: 1,
    semantics: "直连原始回执的 ingestStatus/analysisStatus",
    advertisedWhen: "服务支持直连原始回执时",
    consumer: "iOS 直连同步回执",
    whenAbsent: "不得把单一 succeeded 当回执"
  },
  {
    key: "factsAnalysisViewContractVersion", kind: "capability", version: 1,
    semantics: "读侧两块行视图 currentFacts/publishedAnalysis",
    advertisedWhen: "服务支持两块视图时",
    consumer: "deferred（PR-05 决定：iOS 本版只镜像，不消费；将来消费须 guard == 1）",
    whenAbsent: "不得把 nil 当成“有视图但为空”"
  },
  {
    key: "directSyncBounds", kind: "parameter",
    semantics: "直连单批上界（XML/记录/路线文件/字节）",
    advertisedWhen: "服务支持直连车道时",
    consumer: "iOS DirectSyncBatchBudget（缺省回保守常量）",
    whenAbsent: "回落保守常量；它不是能力位"
  },
  {
    key: "syncCoverageVersion", kind: "capability", version: 1,
    semantics: "`GET /v1/sync/coverage` 覆盖探测",
    advertisedWhen: "服务支持覆盖探测时",
    consumer: "iOS 历史重放跳过已覆盖类型",
    whenAbsent: "照常全量重放"
  }
] as const satisfies readonly HandshakeKeyRegistration[];
