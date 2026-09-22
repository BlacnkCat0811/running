# 代码审查修复记录 — 2026-09-22

本次修改对应上一轮报告中的 12 项问题。所有修复位于当前工作区，未部署、未提交；验证使用临时数据库，不使用真实健康数据库进行故障注入。

| 原问题 | 修复 | 回归证据 |
| --- | --- | --- |
| 1. 训练身份冲突 | canonicalize 优先匹配稳定 workout/session 身份，几何距离匹配只作为后备；保留原 session ID | canonical-correction.test.ts 覆盖全量/增量分组及 5→10→5 km 修正 |
| 2. 恢复中断 | 独立 SQLite 恢复日志记录 prepared/installed/committed；原始快照不被消耗；API 启动后台任务前重放；保护恢复快照免于删除/保留策略清理 | restore-journal.test.ts 覆盖阶段恢复、重复重放、SIGKILL、非法路径；maintenance.test.ts 原有失败注入 |
| 3. 多路线排序 | 路线起始时间、路线 ID、点序号共同确定顺序；海拔序列使用同样顺序 | series-read-repository.test.ts 多路线独立序号测试 |
| 4. 嵌套 GPX | 递归枚举路径，保留大小写，不跟随符号链接 | gpx-path-case.test.ts 嵌套路线两次导入 |
| 5. 回退计划约束 | fallback 接收用户 easyDurationFloorFraction；不足时减少质量课并重新分配跑量预算 | weekly-plan.test.ts 多跑量、多占比、空/有效分区矩阵 |
| 6. 依赖漏洞 | 更新 Fastify、静态插件及锁文件依赖；adm-zip 固定安全补丁版本 | npm audit；干净 npm ci；API/模型/浏览器回归 |
| 7. 心率计算成本 | 事件扫描替代逐边界全数组筛选，保留活跃样本输入顺序；已有 composite breakdown 时跳过重复计算 | 重叠样本一致性及 100,000 样本测试 |
| 8. smoke eval | 固定命名谓词替代 eval；JSON 文件路径作为参数读取 | mobile-smoke-check.test.ts 拒绝可执行表达式与原型属性 |
| 9. 静态文件范围 | API 仅注册构建资源，SPA 路由仅返回固定 index；禁用任意路径 sendFile；Nginx 同步限制资源范围及符号链接 | web-assets.test.ts 覆盖隐藏文件、数据库、源码映射、编码穿越、符号链接；部署模板检查 |
| 10. iOS 持久化错误 | 缓存失败不更新缓存时间；同步日志失败返回明确错误并停止继续上传/导入；日志清理失败保留恢复状态；旧 UserDefaults 仅用于迁移 | StoreRegression.swift 使用真实 SQLite trigger 注入更新/删除失败；iOS 编译及模型回归 |
| 11. 重复 SQLite helper | 新建 SQLiteSupport.swift 统一 prepare/bind/execute/transient/错误码日志 | 两个 production store 的真实实现回归 |
| 12. API 错误分类 | 备份输入/不存在/占用使用类型化错误码；内部异常保持 500 脱敏；非法 HTTP 状态统一归为内部错误 | api-error.test.ts、maintenance.test.ts、API runtime 测试 |

说明：上一轮报告对 eval 的风险分级偏高，该脚本原调用者传入固定表达式，本次仍移除了动态执行。依赖公告的严重程度并不等同于本项目已存在可远程利用的攻击路径；本次以升级和访问边界测试落实防护。

兼容性约束：

- ONNX Runtime 固定为 1.22.0：新解析版本缺少 Intel macOS 的 native binding；同时使用 adm-zip 0.6.1。已通过内嵌 ONNX fixture 的实际模型加载、metadata 校验和推理验证。
- tsx 固定 4.23.0，所属 esbuild 固定 0.28.1：既有 migration checksum 使用函数文本，新版转换器在主线程/worker 的输出差异会破坏兼容。后续升级必须连同迁移校验协议一起评估，不能直接忽略或改写历史校验和。
- 未修改冻结窄屏布局或运行 responsive E2E。iOS 高德 SDK/模拟器/真机 HealthKit 与 WorkoutKit 验收仍是手工项目。
- Nginx 配置只完成模板回归，本机没有 nginx 可执行文件，未执行 nginx -t 或在线发布。


最终验证记录：

- `npm run typecheck`：通过。
- `npm test`：Node 789 通过、3 个平台条件跳过；Web 85 通过。此后新增的原生 ONNX 推理测试、部署模板检查另行通过。
- `npm run test:e2e:web`：10 通过、1 个冻结窄屏用例跳过；包含 Web 构建与包体预算检查。
- `npm run test:ios`：45 个文件类型检查通过（3 个高德依赖文件按原门禁排除），纯逻辑回归通过；production SQLite store 42 个检查通过。
- `npm run rust:verify`：通过，Node 原生集成部分 11 项通过。
- `npm run smoke:api`：生产启动/关闭冒烟通过。
- `npm run ml:test`：23 通过。已在 research/.venv 安装仓库锁定依赖；未修改 Python 依赖声明。
- `npm audit`：0 个已知漏洞。此结果仅代表审计数据库覆盖范围。
- `git diff --check`：通过。

浏览器回归额外发现并修复了设置页错误提示聚焦竞态：将异步 catch 内的 requestAnimationFrame 聚焦改为错误 DOM 提交后的 effect；删除、恢复、删除备份使用相同原则。补充单测且整套桌面 E2E 通过。
