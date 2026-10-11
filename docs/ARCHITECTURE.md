# 项目架构

维护日期：2026-10-07。产品/范围入口：[README](../README.md)、[AGENTS](../AGENTS.md)；已确认问题：[项目审查](PROJECT_REVIEW.md)。

## 交付结构

```text
Apple Health XML/GPX/ZIP ───────────┐
iOS HealthKit只读导出 → HTTP上传 ───┤
                                 v
Node/Fastify → 持久化串行任务 → 私有候选SQLite
                                  ├─ TS解析/canonical/override/tombstone
                                  ├─ 可选Rust Record热循环（受限写许可）
                                  └─ TS特征/评分/恢复/负荷/分区/预测
                                           ↓ 验证、generation/锁、原子发布
                                 主SQLite + 不可变run/bundle
                                           ↓
                                 API DTO → React Web / SwiftUI iOS
Python离线训练 → 固定工件/独立评估 → 校验后Node ONNX推理（否则公式fallback）
```

不存在设备端 Swift scorer、手机 Node runtime、独立 Watch 产品，也不默认维护两套常驻 V1/V2 重算。
iOS 的 WKWebView 不是生产页面路径；Web 内保留的壳兼容布局不等同于原生 App。

## Workspace 职责

| 包/目录 | 职责 |
|---|---|
| [contracts](../packages/contracts/src/index.ts) | 领域合同、schema/version、语义 JSON |
| [api-contracts](../packages/api-contracts/src/index.ts) | Web/API/iOS 消费的 HTTP DTO |
| [health-export-parser](../packages/health-export-parser/src/index.ts) | XML/GPX、安全导入、canonical、身份/删除、恢复事实 |
| [features](../packages/features/src/index.ts) | 显式时点的训练特征及V3兼容读取 |
| [scoring](../packages/scoring/src/model.ts) | CA/TA、质量门控、基线/epoch；不读取当天恢复 |
| [readiness](../packages/readiness/src/index.ts) | 当天恢复规则唯一来源 |
| [normalization](../packages/normalization/src/index.ts) | 条件比较/归一化trace与责任边界 |
| [durability](../packages/durability/src/index.ts) | 专项暴露、耐久证据；未校准不罚分 |
| [training-load](../packages/training-load/src/index.ts) / [training-zones](../packages/training-zones/src/index.ts) | 复合负荷、日状态、分区来源和刺激 |
| [physiology](../packages/physiology/src/index.ts) | VO₂max/VDOT、阈值与公式成绩预测 |
| [prediction-inference](../packages/prediction-inference/src/index.ts) | 工件校验、ONNX残差及可解释回退 |
| [model-eval](../packages/model-eval/src/index.ts) | 回放/消融/竞争/区间与报告合同 |
| [application](../packages/application/src/service.ts) | 装配、命令、重算、checkpoint、领域快照和发布编排 |
| [storage-sqlite](../packages/storage-sqlite/src/database.ts) | migrations、repositories、锁/发布/备份 |
| [api](../apps/api/src/server.ts) | Fastify鉴权、上传、命令、查询与运行时协调 |
| [web](../apps/web/src/App.tsx) | React桌面工作台；冻结窄屏兼容 |
| [ios](../apps/ios/README.md) | SwiftUI、HealthKit、缓存/续传；消费服务端结果 |

[包边界检查](../scripts/check-package-boundaries.mjs) 限制 package→app、Fitness→Readiness 等禁线；不能靠“类型检查能过”引入循环职责。

## 进程与存储

- API负责HTTP/控制，重型导入和重算由现有串行协调机制执行；不增加多API写者/PM2 cluster。
- 主库保存健康事实、训练、覆盖、不可变派生run及已发布指针。
- `runtime.sqlite` 保存来源/任务状态；`rai-control.sqlite` 保存训练目标（轻松时长下限、质量课上限、比赛目标）/计划revision等控制状态（周跑量目标已退役，周容量改为推导，见[DECISIONS](DECISIONS.md) D14）。
- iOS有本地页面缓存和同步任务日志，不成为第二个独立评分/健康事实主库。
- 原库、WAL、控制库、运行时状态、上传和工件都可能包含敏感信息；备份与迁移按[运维](OPERATIONS.md)协调，不只复制一个活跃`.sqlite`文件。

## 请求与一致性边界

读端使用兼容快照/bundle；写命令具备revision/idempotency/generation约束。202 queued不等于成功，查询命令终态；反馈保存与其后分析成功是两个状态。
恢复备份或替换数据集必须改变datasetEpoch，不能继续复用旧缓存/同步游标。
SQLite staging候选必须通过完整性、数据代次与模型gate才可切换；候选失败不改变incumbent。
模型删除/回滚/保留策略见[算法§14](ALGORITHM.md#14-发布删除与回滚)，原始记录不能随模型回滚重写。

## 部署与安全

默认本机回环API；云部署使用Nginx HTTPS、Bearer、来源/Host限制和systemd资源预算，见[部署说明](../deploy/README-UBUNTU.md)。
“本地优先”不表示无网络健康数据传输；用户选云端后，HealthKit ZIP及查询都会传给该服务器。
鉴权、ZIP限额/路径验证、导入写许可、备份/恢复锁和移动端凭证隔离均是独立安全边界；单元测试通过不代替真实环境配置核查。
