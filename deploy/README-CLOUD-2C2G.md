# 当前部署方案：2 核 2GB 云服务器

不迁移到 N100/飞牛，不安装 FRP，不建立第二个可写数据库。
本文件是部署方案和操作步骤，仓库修改不等于已经部署到服务器。

```text
iOS / 桌面浏览器 ── HTTPS:443 ── 云服务器 Nginx
                                  ├─ apps/web/dist
                                  └─ 127.0.0.1:8787 Node API
                                       ├─ 持久化队列 → 串行导入/重算
                                       ├─ 可选 Rust 子进程
                                       └─ 本机 SSD /var/lib/rai
                                            ├─ 主库/控制库/任务状态
                                            └─ 上传/暂存/模型/备份
```

## 1. 配置选择

直接使用 `deploy/rai-api.service`、`deploy/rai.env.example`、
`deploy/nginx-rai.conf`；不使用 `deploy/n100` 的资源配置或反代到 18787。
首次安装的系统用户、Node 22.x、Nginx 和 HTTPS 步骤见 `README-UBUNTU.md`。
磁盘保存 SQLite，不使用内存盘或网络挂载。只向公网开放 80/443；
SSH 限制来源，8787 不开放。

| 项目 | 起步配置 | 边界 |
|---|---|---|
| 服务总内存 | MemoryHigh=1100M，MemoryMax=1400M | 包含 API、线程、子进程；高水位触发回收压力，硬上限可能 OOM |
| Node 堆 | 每个进程/隔离实例 512MiB | 不包含全部原生内存，也不是整组进程预算 |
| CPU | CPUQuota=150% | 最多约 1.5 个核的总配额；不是增加任务并发 |
| 服务 swap | MemorySwapMax=512M | 仅限制现有 swap 的使用，不创建 swap |
| 数值计算线程 | OMP/OpenBLAS/MKL/NumExpr 均为 1 | 避免预测训练抢占整个机器 |
| 任务执行 | 沿用串行重型任务调度 | 不增加 PM2 cluster、多 API 实例或多写者 |
| 校验/引擎 | shadow / TypeScript | 保留安全默认值，Rust 另行验收后启用 |

以上是初始预算，**不是所有规模健康数据都能在 2GB 中完成的保证**。
约留出 600MiB 物理内存给系统和 Nginx，但主机其他服务仍会竞争。
先检查 `free -h`、`swapon --show`、`df -h` 和现有常驻进程。
若系统无 swap，可按云厂商/文件系统支持的方法另行配置 1–2GiB，
它只是突发缓冲，不是提速措施；本方案不自动创建或修改 swap。
systemd 的内存/swap 控制需目标机 cgroup 支持，必须实际检查生效情况。

CPU 或内存不足时先查阶段计时和失败日志。不要直接关闭质量门禁、
盲目提高 V8 堆上限或开放并发写入。大型历史导入可能仍需要分批输入，
或临时扩容云服务器；不会为了本方案自动切换到家庭计算。

## 2. 已有云服务器应用配置

**不要覆盖现有 `/etc/rai/rai.env`。** 保留 Token、数据库路径、
`RAI_SERVER_ID`、`RAI_ATHLETE_ID`、`RAI_DATASET_EPOCH` 和外部 HTTPS 地址，
只合并新资源参数及缺失配置。已有自定义路径以服务器实际值为准。
`RAI_ALLOWED_ORIGINS` 填真实 HTTPS 域名，`RAI_PUBLIC_HOSTS` 保持空，
`RAI_ALLOW_REMOTE_TOKEN_AUTH=1` 仍要求客户端携带正确 Token。

维护前停止手机同步，等已接受任务结束；不要在备份/升级期间运行 CLI 写入。
先记录当前 Git commit、`systemctl cat rai-api`、环境文件和 Nginx 配置。
含 Token 的备份必须 root-only，不上传到 Git。

```bash
cd /opt/rai
sudo install -d -m 700 /var/backups/rai
# 默认预演，确认实际 runtime 路径后才 --apply。
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai --apply
# 备份结束会恢复原有服务状态；维护期间再明确停服。
sudo systemctl stop rai-api
sudoedit /etc/rai/rai.env
sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo systemctl daemon-reload
sudo systemctl reset-failed rai-api
sudo systemctl start rai-api
sudo systemctl show rai-api -p MemoryHigh -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec
sudo journalctl -u rai-api -n 100 --no-pager
```

该流程只适用于程序已更新且 schema 匹配的配置切换。首次引入备份工具时，
先将审核过的脚本单独复制到服务器，不为获得脚本而先覆盖运行中的应用。
若还需更新代码或迁移，使用下一节，不要提前启动新服务。
配置限制需重启才生效；先停服再重启，避免中断活动导入。
不自动删除任何已安装 FRP 服务；若曾配置过，先确认没有其他业务依赖，
再手动停用对应实例和关闭专用安全组端口。本应用不再依赖它们。

## 3. 2GB 主机发布：停服后安装依赖和构建

旧 `upgrade.sh` 会在 API 仍运行时构建，且在线备份只覆盖业务库，
因此**当前低内存方案不要直接用它作为完整发布流程**。
采用维护窗口：完成上一节完整 runtime 冷备份并记录旧 commit 后：

```bash
cd /opt/rai
sudo systemctl stop rai-api
# 失败立即停止后续步骤，保留停服状态；不要无条件 finally/start。
sudo -u rai git pull --ff-only origin main &&
sudo -u rai env NODE_OPTIONS=--max-old-space-size=768 ONNXRUNTIME_NODE_INSTALL=skip npm ci &&
sudo -u rai env NODE_OPTIONS=--max-old-space-size=768 npm run build
# 仅当上面全部成功才继续。构建进程不属于 rai-api 的 systemd 资源组。
# 有待迁移版本时，先只读预演，再明确授权迁移：
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite
# 需要迁移才执行，失败保持停止：
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite --apply
# 首次导入前数据库不存在时，不对不存在的库执行迁移。
# 人工合并 unit/env 变更后：
sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo systemctl daemon-reload
sudo systemctl reset-failed rai-api
sudo systemctl start rai-api
```

上述是分阶段人工操作，**不可忽略任何非零退出状态整段粘贴执行**。
Nginx 读取 dist，维护期间页面可能暂不可用，不承诺零停机。
不复制 Mac 的 node_modules 或 Rust 二进制到 Linux。若启用 Rust，
优先在同架构、兼容 Linux 环境构建并验证，再部署；2GB 主机本地构建时
停服并设置 `CARGO_BUILD_JOBS=1`，仍需关注内存/磁盘，默认暂不启用。
预测模型训练亦不与导入并行；若超内存，离线训练后按既有验证流程发布模型。

## 4. 备份、磁盘和恢复

通用 `deploy/backup-runtime.sh` 备份完整 runtime，包含主库、控制库、
任务元数据和模型，不复制运行中的 SQLite 文件。所有相关路径必须位于
指定 runtime 内；另存环境文件、unit、Nginx 和旧 commit。外置路径需单独停写备份。

- 冷备份包未加密，权限受限；加密后保留一份服务器之外的副本。
- `/var/backups/rai` 的完整包不受应用 `RAI_BACKUP_MAX_*` 自动清理。
  定期核验异机副本后人工清理过期包，不能让备份占满云盘。
- 4GiB ZIP 接受上限不是内存或展开体积承诺；首次大导入前预留上传、
  解压、staging、主库和至少一份完整备份的总磁盘空间。
- 恢复时先停服，验证 `SHA256SUMS`，保留故障现场；将匹配的完整 runtime
  恢复到空目录，设置 rai 所有权，部署匹配旧 commit/依赖/配置后再启动。
  不把旧 tar 叠加解压到运行中的目录，不自动用新版运行旧 schema。
- 回滚到旧数据涉及同步锚点：按既有恢复契约更新 dataset epoch，
  防止手机沿用较新数据集的 anchor。仅更新程序和资源参数不改变 epoch。

## 5. 验收

1. 无 Token 的敏感接口拒绝访问，携带 Token 的 HTTPS 请求可用；
   已有数据时 `/v1/health` 必须同时返回 `status=ok` 和 `databaseReady=true`。
   全新空库的维护状态不是已就绪。
2. 在数据副本验证无变化导入、新增跑步、历史心率更正、睡眠替换；
   检查排队、增量复用和 shadow 对照。再进行一次真实小增量。
3. `systemctl show rai-api -p MemoryCurrent -p MemoryPeak -p Result`、
   `journalctl -u rai-api` 结合主机内存/swap 观察；旧 systemd 不支持 MemoryPeak 时
   使用 cgroup 或监控采样。记录阶段计时、总等待和上传耗时，不混为一个指标。
4. 观察 OOM、交换抖动、磁盘不足和积压；当前未在你的云服务器实测，
   之前本地 8.46 倍只代表合成速度窗口热点，不是云端完整同步倍数。

仓库验证：部署配置、备份成功/失败恢复及既有升级流程共 12 项测试通过，
备份脚本通过 Bash 语法检查。测试使用隔离目录及模拟 systemctl，
不表示已在 Linux 上启动服务；本地没有 Nginx/systemd 可执行程序，
服务器上仍需执行 `nginx -t`、检查 unit 和实际资源限制。
