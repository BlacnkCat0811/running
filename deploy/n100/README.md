# 个人 N100 / FRP 部署与性能优化

> 已不作为当前部署方案。当前选择为 **2 核 2GB 云服务器单机部署**，
> 见 [`../README-CLOUD-2C2G.md`](../README-CLOUD-2C2G.md)。
> 本目录仅保留旧方案及兼容入口，不需安装 FRP 或迁移到家庭 NAS。

本目录是**待安装的部署模板**，不会自动操作云服务器、飞牛或真实数据库。先备份，再按步骤切换。
不需要改 Python、不需要 Redis/PostgreSQL、不增加云/家里双写。

可选 Rust 解码/记录写入执行器已接入，构建、协议保护、双引擎对照与实测限制见
[`RUST_DATA_ENGINE.md`](../../docs/RUST_DATA_ENGINE.md)。默认仍用 TypeScript，不能直接把 macOS 二进制复制到 N100。

后续后端队列/事务回执重构已落地，完整接口与恢复边界见
[`BACKEND_REFACTOR_IMPLEMENTATION.md`](../../docs/BACKEND_REFACTOR_IMPLEMENTATION.md)。
新导入现在由服务端持久化排队并返回 202；iOS 的忙碌等待保留作旧服务兼容。

## 1. 拓扑与前提

```text
iOS / desktop → HTTPS 云 Nginx → 127.0.0.1:18787 frps
                                  ⇅ 验证证书的 TLS TCP 隧道
                           N100 VM frpc → 127.0.0.1:8787 API
                                             ├─ Web dist
                                             ├─ import / recompute / trainer
                                             └─ 本地 SSD runtime
```

- 云 2C2G 只跑 Nginx/frps；应用和**唯一可写数据集**全放在家里。
- 这里的命令面向 N100 上有 systemd 的 Debian/Ubuntu VM。若飞牛作为 VM 内的系统，
  不要直接覆盖 NAS 系统服务；建议另建 Linux VM 或自行转换为容器配置。
  此方案未在飞牛容器中验收。容器的 `127.0.0.1` 不等于宿主机或另一个容器。
- `rai-api.service` 的起步配置假设 VM 有 **4 vCPU、至少 6 GiB 内存**，宿主机还有余量；
  N100 的实际内存未知，不要求你必须升级。先看宿主机 `free -h` 和 NAS 其他负载再分配。
  `CPUQuota=200%` 是最多约两个 CPU 的配额，不是两个并发计算任务。
- 所有运行数据、暂存、备份在 VM **本地 SSD 文件系统**的 `/var/lib/rai`。
  不在 SMB/NFS 上直接打开 SQLite；NAS 共享目录仅接收已完成的备份包。
- 家里断网/断电时云端不能继续处理请求；iOS 保留未完成批次、恢复后重试。
  不提供“云端自动接管写库”，避免数据分叉。
- 上传方向主要受手机上传、云出口、家里下载限制；查询/备份下载才经过家里上行。
  FRP 不会绕过云出口限速，也不保证 N100 的单核比云机更快，必须实测。

## 2. 本轮代码优化与边界

### 已实现

- 同一 `sourceId` 重试复用导入任务；inspect 不抢主库写锁；iOS 遇到
  `mutation_conflict` 等待而非立即报错（可取消、最长等待 30 分钟）。
- 重算的中间进度写入最多每 250 ms 一次；阶段起止和最终结果仍落盘，
  不节流取消检查、不改评分公式。
- iOS 查询任务：前 30 秒每 2 秒一次，之后每 5 秒一次；终态失败立即返回，
  不再被当成网络异常反复轮询。
- 每个完成/失败导入任务都有可选的 `performance`：
  `totalMs` 和 `stagesMs.{backup,stagingCopy,parseImport,changeAnalysis,recompute,activation,cleanup}`。
  老任务无此字段仍兼容。计时使用单调时钟，失败阶段也计时并持久化。
  `parseImport` 包括解析器子进程启动、XML 导入和报告生成；
  `recompute` 包含计算子进程及其可选完整对照。尚未拆成逐个算法的 CPU 时间。
  **不包括上传/解压/inspect、排队、终态回调耗时**，不能称为手机端端到端耗时。
- `RAI_IMPORT_VALIDATION_MODE=shadow|off`：
  - 默认 `shadow`：保留增量与全量重放对照。
  - `off`：显式跳过额外完整重放，可缩短日常增量同步，风险是少一道等价性检查。
  - **两者都保留模型激活质量门禁**（`rai-shadow-gate-v1`）、删除保护、数据库发布保护。
  - 初次导入/全量重算/无需重算任务不会执行该额外对照，记录 `not-run`。
  - 拼错配置会拒绝启动，不会悄悄关闭校验。

### 不做的“优化”

- 不在 staging 计算期间直接释放写锁：主库若收到训练覆盖/模型激活等写入，
  之后用旧副本替换会丢更新。安全的短锁方案需要**数据代际检查 + 写入日志重放/重建**，
  并覆盖训练修改、删除、模型训练、恢复等全部写入方；本轮不伪装已实现。
- 不重复开启 WAL/NORMAL/5 秒 busy_timeout：代码已配置。NORMAL 在断电时可能丢最近提交，
  不等同于 FULL 耐久性；不要进一步改为 OFF。
- 不盲加索引或 64MB/连接缓存。`health_records` 没有上个口头建议里的 `workout_id`，
  也已有 type/time 与 source/time 索引。先测 `EXPLAIN QUERY PLAN` 再做显式迁移。
- 不把全量对照“异步化后直接激活”：失败候选不能先变成当前结果。
- 不假设不同日期完全独立：新增/更正睡眠、HRV 和训练会影响后续基线与模型时间线。

## 3. 安装应用（N100 Linux VM）

沿用上级 `README-UBUNTU.md` 的 rai 用户、Node 22.x、依赖安装、Web build 和显式迁移步骤；
仓库在 `/opt/rai`。构建不要与正式同步同时进行；开发 Mac 的 node_modules 不能直接拷到 Linux。
下面只安装模板，不自动启用：

```bash
sudo install -d -m 700 /etc/rai
sudo install -d -o rai -g rai -m 700 /var/lib/rai
sudo install -m 600 deploy/n100/rai.env.example /etc/rai/rai.env
sudoedit /etc/rai/rai.env
sudo install -m 644 deploy/n100/rai-api.service /etc/systemd/system/rai-api.service
sudo systemctl daemon-reload
```

替换 API Token 与域名；迁移时保留原来的 `RAI_SERVER_ID`、`RAI_ATHLETE_ID`、
`RAI_DATASET_EPOCH`、Token 和外部 HTTPS URL。未配置过身份时代码默认值就是模板值。
恢复旧数据或换成另一套数据集时，才按恢复契约更新 epoch，防止 iOS 旧 anchor 误用。

`NODE_OPTIONS` 是每进程上限；systemd MemoryMax 才覆盖 API/子进程/worker 的整体。
内存不足时先停止并发构建、降低线程数/数据批次，再测 RSS，不能靠无限增大 heap。
目前保持既有任务互斥策略，不启动第二个 API 指向同一个数据库。

## 4. 安装 FRP（云 frps，家里 frpc）

两端使用同一固定版本的官方 FRP，校验下载文件的官方 checksum，二进制放在 `/usr/local/bin/`。
模板使用 TOML；先用实际安装版本的 `verify` 验证，不能直接复制 full-example 启动。
API Token 和 FRP Token 必须不同，可分别用 `openssl rand -hex 32` 生成。

```bash
# 两端分别执行
sudo useradd --system --no-create-home --shell /usr/sbin/nologin frp
sudo install -d -o root -g frp -m 750 /etc/frp /etc/frp/tls
sudo install -m 644 deploy/n100/frp@.service /etc/systemd/system/frp@.service
# 云上：
sudo install -o root -g frp -m 640 deploy/n100/frps.toml /etc/frp/frps.toml
# 家里（不是在云上执行）：
sudo install -o root -g frp -m 640 deploy/n100/frpc.toml /etc/frp/frpc.toml
```

### 隧道 TLS 不能只加密、不验证服务端

配置里的 `frp.example.com` 必须解析到云 IP，且匹配服务器证书 SAN。
在可信机器生成专用 CA 和服务器证书（示例，不覆盖现有证书）：

```bash
umask 077
mkdir rai-frp-pki && cd rai-frp-pki
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -keyout ca.key -out ca.crt -subj '/CN=RAI private FRP CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr \
  -subj '/CN=frp.example.com'
printf '%s\n' 'subjectAltName=DNS:frp.example.com' 'extendedKeyUsage=serverAuth' \
  'basicConstraints=critical,CA:FALSE' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 365 -sha256 -extfile server.ext
```

- 云 `/etc/frp/tls/` 放 `server.crt`、`server.key`，root:frp，0640。
- 家里 `/etc/frp/tls/` 只放 `ca.crt`，root:frp，0640。
- `ca.key` 留在可信离线位置，不放云端或仓库；证书到期前续签并重启 FRP。
- 编辑两端 TOML 中的 Token、域名；不配置 dashboard，不开启 QUIC/KCP。

```bash
# 各自验证对应的配置
sudo -u frp /usr/local/bin/frps verify -c /etc/frp/frps.toml
sudo -u frp /usr/local/bin/frpc verify -c /etc/frp/frpc.toml
# 云：systemctl enable --now frp@frps；家里：systemctl enable --now frp@frpc
```

安全组只放公网 80/443、FRP 7000（家庭出口固定时限该 IP）、受限管理 SSH。
18787 仅绑定云回环，8787 仅绑定家里回环；**不开放这两个端口**。

## 5. 云 Nginx

使用本目录 `nginx-rai.conf` 替换旧 RAI 站点：全部请求通过 FRP 到家里，
云不再存放旧版 Web/API。替换域名和证书路径，签发 HTTPS 证书后才启用 443 配置。
首次签发可先只启用模板的 80/ACME server，用 certbot webroot 签发，再启用完整模板。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

上传流式转发、不缓冲 4GB 请求体到云磁盘、不做写请求自动重试；
仅上传路由放宽大小限制。ZIP 不再经 FRP 二次压缩。
`Authorization` 透传客户端令牌，不在 Nginx 内注入，不设置匿名健康数据读取。
当前桌面 Web 若没有提供令牌的方式，应通过可信本地环境或客户端令牌接入解决，
**不要为了页面能打开而设置 `RAI_PUBLIC_HOSTS` 公开健康数据**。
代理错误日志仍可能包含 URL，权限与保留期需按敏感数据管理；不记录请求体/Token。

## 6. 一致性迁移、备份与回退

单独 `POST /v1/backups` 只备份主业务库，**不是**全资产备份。
完整恢复还需 runtime.sqlite、rai-control.sqlite、模型 artifacts、导入目录、
身份与配置。禁止分别热拷贝几份数据库后声称它们来自同一时刻。

本目录 `backup-runtime.sh` 先停 API（包括其 worker），打包整个 runtime，再恢复原服务状态。
默认 dry-run；需 root 权限执行 `--apply`。它不自动删除历史备份，也不创建定时任务。
仅适用于所有持久化文件在 runtime 内、没有其他 CLI 写入进程的单实例部署：

```bash
sudo install -d -m 700 /srv/rai-backups
sudo bash deploy/n100/backup-runtime.sh --output-dir /srv/rai-backups
# 确认备份空间充足、没有 CLI 正在重算/导入后：
sudo bash deploy/n100/backup-runtime.sh --output-dir /srv/rai-backups --apply
# 包内验证：
cd /srv/rai-backups/rai-runtime-YYYYMMDDTHHMMSSZ-PID
sha256sum -c SHA256SUMS
```

空间需同时容纳主库、导入备份、staging 副本、解压文件和新归档；不要仅以主库大小估算。
包未加密，只留在可信本地磁盘；在停服窗口外，用你已有的加密备份工具加密后复制到 NAS/
异机。配置 `/etc/rai/rai.env`、代码版本、FRP 版本另行加密保存。CA 私钥另管。
该冷备份适合升级/迁移前，不适合每 40 分钟停服务；频繁主库热备份仍可用现有接口。

### 切换流程

1. 在家里先安装代码/依赖、建目录，保持 API 停止；记录原配置/代码版本。
2. 暂停手机同步，停止旧云 API 和旧备份 timer；生成最终完整包，不接受新写入。
   脚本完成会恢复原先运行的服务，因此迁移场景应先手动停旧服务，再在 inactive 状态打包。
3. 校验包，在家里的**空目录**解包，保持原 runtime 相对布局；不要覆盖一个正在使用的库。
   所有 DB/WAL/SHM 作为同一停止状态归档保留，不挑拣单文件。
4. `chown -R rai:rai /var/lib/rai`；按上级部署文档预演并显式执行必要迁移。
5. 家里启动 API/frpc；云检查回环 18787；再将 Nginx 上游切到 18787。
6. 测试手机小批同步、训练修改、重复提交复用、页面读取、失败恢复。
7. 保留旧云包，但禁用旧 API 自动启动。家里首次接受写入后，旧云库即已过时。

回退代码时先停止写入、备份当前家里状态；需要回云则迁回**最新完整数据集**，
不能直接启动切换前的旧云库。结构迁移不保证向后兼容，必要时用对应版本恢复并明确数据损失。

## 7. 性能验收：先测再开快速模式

使用同一份主库副本与相同导出，分别在云和家里测基线；
测 shadow/off 也必须每次还原相同基线，避免第二次变成 unchanged 得到虚假提速。
不在生产 active 库做破坏性 benchmark。

记录至少三组：首次导入、最近一跑增量、无变化重复同步。每组多次记录中位数：

| 指标 | 取得方式 |
|---|---|
| 端到端、上传耗时、ZIP 字节数 | 真机日志/手动计时；服务端任务计时不含上传 |
| 各导入阶段 | 带 Token 读取 `/v1/import-jobs/latest` 的 `performance` |
| 重用/重算训练数 | 同响应 `summary.featuresReused/featuresRecomputed` |
| 总内存峰值、OOM | systemd cgroup / journal，不只看一个 Node RSS |
| 磁盘与网络 | `df -h`、系统 I/O 与网络统计 |
| 正确性 | 训练数、删除/修改、特征结果、模型门禁、iOS 恢复游标 |

先使用 shadow 验证一轮实际增量。若确认额外全量重放占主要成本、愿意接受少一道等价性检查，
手动设置 `RAI_IMPORT_VALIDATION_MODE=off` 并重启。发生算法/解析器/配置升级、历史数据更正、
结果异常时切回 shadow。普通完整重算不等于验证增量是否等价。
这里**没有自动每周 shadow 任务**；日后若需要应设计在隔离副本上跑对照，不与在线写库竞争。

验收要求：重复 source 不产生重复任务；其他主库写入仍有保护；
数据/门禁结果与基线一致；小批同步无 OOM；家里离线时批次不会被误报成功；
备份在隔离目录实际恢复并通过 `PRAGMA quick_check`/`foreign_key_check` 和接口检查。
不承诺固定倍数。FRP 断线、备份超期、磁盘不足先接入你已有 NAS/云监控，避免再跑重型监控栈。

## 8. 配置依据（官方）

- FRP server/client TOML 字段：`https://github.com/fatedier/frp/tree/dev/conf`
- FRP TLS：`https://gofrp.org/en/docs/features/common/network/network-tls/`
- SQLite WAL 本地文件系统限制：`https://www.sqlite.org/wal.html`
- SQLite NORMAL/FULL 耐久性：`https://www.sqlite.org/pragma.html#pragma_synchronous`

升级工具后重新执行 `frps/frpc verify`、`nginx -t` 与应用测试；此模板不是实际服务器验收报告。
