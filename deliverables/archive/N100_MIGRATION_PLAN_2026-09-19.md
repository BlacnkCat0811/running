# N100 迁移方案：云机 → 飞牛 VM

> ## ⛔ 已作废（2026-09-19 09:48）
>
> 小唐决策：**不迁移到 N100，继续部署在当前云服务器**。
> 原因（排查中确立的事实）：N100 只有 4 核 4 线程，PVE 上 4 个 VM 已分配 14 vCPU（超分 3.5×）、
> 14 GiB 内存；RAI 是 CPU 密集型，跑在 fnOS VM 里会与 iKuai / OpenWrt 软路由抢同一颗 CPU，
> **直接威胁全家网络**；且文档推荐的「另建 Linux VM」在该机上已无资源余量。
>
> ⇒ **本文档仅保留作背景参考**，执行方案改见
> [`CLOUD_DEPLOY_PLAN_2026-09-19.md`](CLOUD_DEPLOY_PLAN_2026-09-19.md)。
> 其中「云端 frps 三处全局项不可照模板改」「旧 vhost 住着 `/wb2api/`」等**云机侧**事实
> 仍然有效，将来若重启迁移可直接复用。

日期：2026-09-19 ｜ 状态：**已作废**（原为：待小唐确认，未执行任何改动）

排查对象：工作区未提交改动（30 改 + 50 新增）中的 `deploy/n100/` 部署模板，
以及 `docs/BACKEND_REFACTOR_IMPLEMENTATION.md`、`docs/RUST_DATA_ENGINE.md`、
`docs/INCREMENTAL_COMPUTE_OPTIMIZATION.md`。

---

## 0. 结论

模板把「云只做入口、家里存唯一可写数据集」这件事写清楚了，质量高（默认 dry-run、
默认不启 Rust、默认不关校验、明确列了「不做哪些伪优化」）。但它是**面向一台干净的、
只服务 RAI 的服务器**写的，而真实云机上：

1. **frps 是共用的**——同一实例正服务着飞牛 NAS 的隧道；
2. **nginx 的 rai vhost 里住着第二个服务**（wb2api 网关）；
3. **线上开着匿名只读**，模板要求关掉。

⇒ 三处都不能按模板字面执行。本方案给出**插入式改法**，硬约束是
「NAS 隧道不断、wb2api 入口不断、健康数据不当众公开」。

**最大收益不是 CPU，是内存**：云机 2 GiB 是当前导入失败风险的根源；
目标 VM 8 GiB 可让 `MemoryMax=4G` 真正给足。

---

## 1. 云机实测现状（2026-09-19 09:30，只读探测）

服务器 `lhins-3gatdqed` / `tpandmr.xyz` / 101.33.202.40。

| 项 | 实测值 |
|---|---|
| 内存 | 总 1.9 GiB ／ used 584 MiB ／ **available 1.3 GiB** ／ swap 已用 216 MiB |
| 磁盘 | `/dev/vda2` 50 G，用 15 G，**余 33 G** |
| frps | Docker `fatedier/frps:v0.71.0`，`--network host`，`bindPort = 7000` |
| frps 关键项 | **无 `proxyBindAddr`（默认 0.0.0.0）**、**无任何 TLS 配置**、`allowPorts = [{8000–8030}, {single=8443}]`、`webServer` 7500 仅回环 |
| wb2api | Docker `ghcr.io/sliverkiss/workbuddy2api`，`0.0.0.0:7863`（外层防火墙未放行，仅 nginx 可入） |
| rai vhost | `/etc/nginx/sites-available/rai`（约 68 行）：443 ssl http2 → `root /opt/rai/apps/web/dist` + SPA try_files；`/v1/` → 8787；`/v1/imports/uploads` → 8787（4g，3600s）；**`/wb2api/` → 127.0.0.1:7863**；80 → 301 |
| systemd | `rai-api.service`(enabled)、`rai-backup.timer`(enabled)、`rai-backup.service`(static) |

两条推论（已证实的、上一版只能推测的）：

- 🔴 **现有 frps 缺省绑 0.0.0.0**，所以「让 18787 只绑回环」**不能靠 `proxyBindAddr`**——
  那是全局设置，改了会把 NAS 的 8000–8030/8443 一并变成只绑回环，NAS 外网访问全断。
- 🔴 **现有隧道无 TLS** ⇒ 隧道内数据（含 NAS 账号密码、RAI 的健康数据与 Bearer 令牌）
  在公网段明文传输。这是既存问题，也正是 RAI 这条链路**不该沿用**它的理由。

---

## 2. 目标拓扑

```text
N100（4 核 4 线程）
└─ PVE
   └─ 飞牛 fnOS VM（4 vCPU / 8 GiB）
      ├─ RAI API        127.0.0.1:8787   ← 唯一可写数据集 /var/lib/rai
      ├─ Web dist       由 API 托管（fastify-static）
      └─ frpc           连云端 7001（新实例，TLS）

云 2C2G
├─ nginx 443
│   ├─ /                  → 127.0.0.1:18787 ─┐
│   ├─ /v1/               → 127.0.0.1:18787 ─┤
│   ├─ /v1/imports/uploads→ 127.0.0.1:18787 ─┤ 经 frp 隧道
│   └─ /wb2api/           → 127.0.0.1:7863   │ （不动）
├─ frps  #1  7000  → 服务 NAS（不动）
├─ frps  #2  7001  → 只服务 RAI（新增）──────┘
└─ wb2api    7863（不动）
```

⚠️ frpc 的 `serverAddr` 是全局项 ⇒ **一个 frpc 只能连一个 frps**。
走独立 frps 就必须在飞牛 VM 里再跑一个 frpc 实例（内存约 10–20 MiB，可接受）。

---

## 3. 三条硬约束（不可让步）

| # | 约束 | 违反后果 |
|---|---|---|
| 1 | nginx 改 rai vhost 必须**逐段插入**，绝不整文件覆盖 | `location /wb2api/` 消失 ⇒ wb2api 网关入口断（SSE 依赖它） |
| 2 | 不动现有 frps `allowPorts` / `proxyBindAddr` / 全局 TLS | NAS 隧道断（注册失败或端口只绑回环或 TLS 校验不过） |
| 3 | `/var/lib/rai` 必须落 **SSD 文件系统** | SQLite WAL + 每次导入 ≈500 MiB 复制落机械盘 ⇒ 慢一个数量级，且断电丢提交 |

---

## 4. 精确改动点

### 4.1 云端：新增第二个 frps（推荐方案 A）

与现有 frps 并存，完全不碰 NAS 那条链路。实现方式与现有运维一致（Docker + host 网络）：

- 容器名 `frps-rai`，`--restart unless-stopped --network host`
- 配置 `/opt/frps-rai/frps.toml`：
  - `bindAddr = "0.0.0.0"` / `bindPort = 7001`
  - `proxyBindAddr = "127.0.0.1"` ← 只在 RAI 这个实例上生效，安全
  - `allowPorts = [{ single = 18787 }]`
  - `auth.method = "token"` + **独立的随机 token**（与现有 frps、与 `RAI_API_TOKEN` 三者互不相同）
  - `transport.tls.force = true` + `certFile`/`keyFile` 指向专用证书
  - 不启用 dashboard / HTTP vhost / QUIC / KCP
- 防火墙：**放行 7001**；🔴 **18787 绝不放行**（它已绑回环，只有云 nginx 能到）——
  照 frp-ops 惯例去放行 18787 会把 API 直接裸到公网、绕过 nginx 的 TLS 与限速。
- 证书：按模板第 4 节用自有 CA 签 `frp` 域名证书（`serverName` 必须与 SAN 一致）。

**方案 B（不推荐，仅列出）**：复用现有 frps——`allowPorts` 追加 `{single=18787}`，
防火墙挡 18787。代价：该隧道**无 TLS**（健康数据明文过公网），且要开 TLS 就得动全局配置、
NAS 的 frpc 必须同步改，改动瞬间 NAS 会断。**不建议**。

### 4.2 飞牛 VM：安装 RAI

沿用 `deploy/README-UBUNTU.md` 的 rai 用户 / Node 22.x / `npm ci` / 显式迁移流程，仓库放 `/opt/rai`。
按 `deploy/n100/README.md` §3 安装 unit 与 env（`rai.env.example` 已含 `RAI_ALLOW_REMOTE_TOKEN_AUTH=1`）。
额外必须手动补的（见 §6）。

### 4.3 nginx：插入式改造（唯一安全改法）

改前 `cp -a /etc/nginx/sites-available/rai /root/nginx-rai.bak.20260919`，改后 `nginx -t` 再 reload。

| 段 | 改动 |
|---|---|
| `root /opt/rai/apps/web/dist;` + `index` | 删除（dist 搬去家里，改由 API 托管） |
| `location /` | 由 `try_files` 改为带上全部 proxy header 的 `proxy_pass http://127.0.0.1:18787;` |
| `location /v1/` | `8787` → `18787`，追加 `proxy_next_upstream off;`（写请求绝不隐式重试） |
| `location = /v1/imports/uploads` | `8787` → `18787`，其余保持（4g、3600s、不缓冲） |
| `location /wb2api/` | **一字节不动** |
| 顶层 `limit_req_zone` / `ssl_*` / `include` | 保留现有（比模板的新配置更贴合现状，不换） |

### 4.4 数据迁移

按模板 §6 的 7 步：停写 → 冷备份（整 runtime，含 `rai-control.sqlite` 与模型 artifacts）
→ 校验 sha256 → 解包到**空目录** → `chown -R rai:rai /var/lib/rai` → 显式迁移 → 起 API。
🔴 `POST /v1/backups` 只备份主业务库，**不是**全资产备份，不能拿它当迁移包。

### 4.5 云端收尾

`systemctl stop rai-api && systemctl disable rai-api`；
`systemctl stop rai-backup.timer && systemctl disable rai-backup.timer`。
家里首次接受写入后，云上那份库即已过时 ⇒ 只保留、不再启动。

---

## 5. 资源账与性能预期

| 维度 | 云机现状 | 目标 VM | 判断 |
|---|---|---|---|
| 内存 | 1.9 GiB（avail 1.3，swap 已用 216 MiB） | 8 GiB | 🔴 **决定性改善**。单次导入临时峰值约 1.0–1.5 GiB，`MemoryMax=4G` 可真正给足 ⇒ OOM 风险大幅下降 |
| CPU | 2 核（共享型） | 4 vCPU（N100 = 4 核 4 线程，**无超线程**） | 🟡 核数翻倍利好并发 I/O；**单核大概率不如基准机**（N100 睿频 3.4 GHz，单核约为 Ryzen 5 3600X 的 50% 量级） |
| 磁盘 | 50 G 用 15 G | 待确认 | 🔴 必须 SSD，建议 ≥15 G 可用 |

⚠️ 三点措辞纪律（文档自己也强调了）：

- `docs/INCREMENTAL_COMPUTE_OPTIMIZATION.md` 的 8.46× 与 `RUST_DATA_ENGINE.md` 的 32%，
  基准机是 **Ryzen 5 3600X**，**不是 N100**，不能外推。
- 模板自己写了「不保证 N100 的单核比云机更快」——**搬到 N100 存在变慢的可能**，
  尤其 CatBoost 训练与 `shadow` 模式下的额外全量重放（单核密集）。
- 若实测确认 shadow 是主要成本，可考虑 `RAI_IMPORT_VALIDATION_MODE=off`，
  但必须在**同一台机器**上先测 shadow 基线，且不得把「关掉校验省下的时间」说成算法提升。

---

## 6. 不做会踩的坑（配置细节）

1. 🔴 **`RAI_ALLOWED_ORIGINS` 必须把 IP 也列上**：`RAI_ALLOW_REMOTE_TOKEN_AUTH=1` 时，
   带令牌的 `/v1` 请求会校验 `Origin`，不在名单里直接 403 `untrusted_origin`
   （`apps/api/src/local-request-security.ts:145-148`）。
2. **`RAI_ALLOW_REMOTE_TOKEN_AUTH=1` 为什么必开**：不开时静态资源要求 Host 是
   `127.0.0.1:8787`（同文件 `:126-131`），FRP 下 Host 是域名 ⇒ 整个 SPA 403。
3. 🔴 **`RAI_PUBLIC_HOSTS` 留空 ⇒ Web 读请求全部 401**。不会死锁
   （`apps/web/src/App.tsx:240-270` 把 `/settings` 列入 `canOpenWithoutDatabase`，health
   拿不到也放行设置页），但需去设置页手填令牌；而设置页文案仍写「浏览数据无需令牌」
   （`apps/web/src/pages/SettingsPage.tsx:395`），**与实际相反，须同步改**。
4. **迁移会漏掉的 LLM 配置**：两个 env 模板都没有 `RAI_LLM_*`，代码却读 5 个变量
   （`apps/api/src/weekly-plan-llm.ts:96-105`）。不手动补 ⇒ 周计划生成**静默退回启发式**
   （`weekly-plan-service.ts:144` 只 push 一条 warning，仍返回 200）。
5. **`tsx` 在 devDependencies** ⇒ `npm ci` 不能带 `--omit=dev`，否则 `--import tsx` 起不来。
6. **unit 硬编码 `/usr/bin/node`** ⇒ 必须系统级装 Node 22.x（`>=22.12 <23`），**不要用 nvm**。
7. **迁移不随启动执行**：首次启动前必须显式跑迁移（`migrationPolicy:"refuse"` ⇒ 有 pending 就 exit 78）。
8. **必须 build web**：API 托管 dist，且 `ExecStartPre=scripts/check-web-build.mjs` 会直接拦掉启动。
9. **PVE 层面**：VM 的 CPU type 用 `host`（别用默认 `kvm64`，性能打折）；VM 磁盘用
   virtio-scsi + SSD 后端，缓存模式不要用忽略了 flush 的 writeback。

---

## 7. 待确认（红线，需小唐回答后才能动手）

1. 🔴 **N100 的存储构成**：VM 系统盘是 NVMe/SATA **SSD** 还是机械盘？
   飞牛的存储池落在哪块盘？`/opt/rai` 与 `/var/lib/rai` 必须落 SSD。
2. 🔴 **飞牛 VM 系统盘的可用空间**（`df -h`），以及 `/opt`、`/var` 是否同一分区。
3. **PVE 上除飞牛 VM 外还有别的 VM/LXC 吗**？N100 只有 4 核 4 线程，
   给飞牛 4 vCPU 后 PVE 宿主自身也要核 ⇒ 需要重新分配还是飞牛拿满？
4. **飞牛 VM 里 fnOS 的 systemd 是否健全**（能否装自定义 service、能否加系统用户）；
   现有 Docker frpc 是否就在这个 VM 内（决定 §4.1 的 frpc 怎么加）。

---

## 8. 文档自述未验收的部分（不要当成已验证）

- 桌面浏览器 E2E **未跑**（本机无 Chrome/Edge，被前置检查阻塞）⇒ 浏览器端到端未验收。
- CI 的 Rust 任务已配置，但**远端 CI 未在本次执行中运行**。
- **没有任何 N100 实测数据**：无真实用户数据的提速比例、无目标机器内存峰值。
- Rust 引擎**默认关闭**，可先不上；如需上，先在做完整备份、用真实数据副本通过双引擎对照。

---

## 9. 建议的执行顺序（确认后）

```text
0  回答 §7 的 4 个问题，确认域名保持 tpandmr.xyz
1  云侧：新增 frps#2 + 证书 + 防火墙放行 7001（18787 不放行）
2  云侧：备份 rai vhost，插入式改造，nginx -t 后 reload，验证 /wb2api/healthz 仍 200
3  家里：装 Node22/依赖/建目录/装 unit/env（补 §6 全部配置），保持 API 停止
4  停写（暂停手机同步）→ 冷备份整 runtime → 校验 → 传到家里
5  家里解包 + chown + 显式迁移 → 起 API + 起新 frpc
6  云侧：nginx 上游切到 18787 → 手机小批同步 / 改训练 / 重复提交 / 页面读取 / 失败恢复
7  按模板 §7 测三组基线（首次导入 / 最近一跑增量 / 无变化重复），记录中位数
8  云侧收尾：停并禁用 rai-api 与 rai-backup.timer
```

回滚点：任一步失败 ⇒ 云侧 nginx 上游改回 8787、启回 rai-api；家里保持停止。
代码层回滚 = `git reset --hard <旧HEAD>`；**数据库回滚只能靠第 4 步的冷备份**。
