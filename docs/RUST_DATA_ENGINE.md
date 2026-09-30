# Rust 数据执行器

职责：可选的XML/GPX解码与Record写入热循环，不是新的后端/客户端产品。
[架构](ARCHITECTURE.md)、[决策](DECISIONS.md)、[云端部署](../deploy/README-UBUNTU.md)共同限定边界。

## 保留的TS责任

HTTP/鉴权/队列/发布仍由Node负责；稳定ID、JS数值/日期/JSON兼容、Workout/canonical/删除保护、睡眠HRV、特征/评分/负荷/预测仍使用现有TypeScript合同。
Rust不创造另一套session身份，不读API Token，不写活动主库。

## 私有候选写入

[原生worker适配](../packages/health-export-parser/src/native-worker.ts)选择引擎，[Record writer](../packages/health-export-parser/src/native-record-writer.ts)封装写许可。
目标必须是受控`.importing.<UUID>`候选库、realpath相同且有匹配的一次性许可；许可不能来自上传内容或公共HTTP参数。
中转SQLite与候选文件使用每次attempt独立路径；旧孤儿进程不能覆盖新attempt。失败候选整体丢弃，不把部分Rust写入与部分TS重试拼接发布。
解码/写入资源超限与取消必须传播为失败；GPX配额与坏XML状态不同，见[ADR-004](adr/ADR-004-healthkit-sync-invariants.md)。

## 不变量B1/B2

- B1：候选库generation/change ledger与实际Record写入保持一致，重试不能跳过必要更新或复活tombstone。
- B2：不得在TypeScript重判阶段清空Rust刚生成的generation结果；身份/内容变化必须由同一合同决定。
- Rust引擎version进入payload identity，换二进制不能继续命中旧载荷锚点。
- 常驻shadow reference已移除；旧“每次增量都双跑TS”的说明和实测已删除。显式离线parity/benchmark不是生产双跑。

## 构建和选择

```bash
npm run rust:build
npm run rust:verify
```

[工具入口](../scripts/rust-worker.mjs)和仓库Rust toolchain/lock是版本依据。缺工具链时明确报告，不把未运行当通过。
默认`RAI_IMPORT_ENGINE=typescript`。启用Rust须部署匹配二进制并核对`RAI_RUST_BINARY`；生产例子使用仓库外`/opt/rai-native/rai-data-worker`，不是凭空存在的文件。
`RAI_RUST_FALLBACK=typescript`仅允许受支持失败分类的回退，数据/资源错误不能吞掉；`none`适合验证失败方向或避免benchmark偷偷跑回TS。

## 云服务器就地构建

先在兼容目标环境构建并运行parity/导入/取消测试，再把工件复制到受控目录；系统服务只读工件、只对runtime有写权限。
不要在未安装二进制时只改env启用Rust。线上部署/资源预算不由本机测试自动证明。
记录工件版本/hash、机器/数据规模、同缓存状态和重复轮次；旧异机冷/热单次耗时不得拼成提速结论。
