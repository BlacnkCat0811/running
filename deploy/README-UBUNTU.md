# Ubuntu 部署

当前方案：**2 核 2GB 云服务器单机部署，不迁移 N100，不使用 FRP**。
本页是唯一现行云部署入口，资源预算和维护顺序见文末。
不要用示例环境文件覆盖现有 Token、身份标识或路径；仓库修改不代表线上已部署。

应用只监听 `127.0.0.1:8787`（`RAI_API_HOST` / `RAI_API_PORT` 可覆盖），由 Nginx 提供 HTTPS 并反代 API；**Nginx 不再托管任何静态文件**（Web 前端已于 2026-10-17 退役）。SQLite、上传文件、运行时状态和备份放在 `/var/lib/rai`，不要把该目录放到 Web 根目录或共享盘。

本页描述目标拓扑（不代表已核实或修改你的线上状态）：

- 站点根路径与 `/assets/*` 一律 `404`，只有 `location /v1/` 反代到 `127.0.0.1:8787`，**透传客户端自己的 Bearer Token**；
- 不做 Nginx 侧 Token 注入，必须透传客户端自己的 Bearer Token；
- 后端 `apps/api/src/local-request-security.ts` 统一校验 Bearer 与请求上下文；云上必须配置 `RAI_API_TOKEN`。

## 首次部署

适用于腾讯云 Ubuntu 22.04/24.04。先在云安全组开放 TCP `22`（仅你的办公 IP）、`80`、`443`，**不要开放 `8787`**。

```bash
sudo useradd --system --home /opt/rai --shell /usr/sbin/nologin rai
sudo mkdir -p /opt/rai /var/lib/rai
sudo chown -R rai:rai /opt/rai /var/lib/rai
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx openssl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # 必须落在受支持的两条 LTS 线上：v22.12.0+ 的 22.x（默认），或 24.x

sudo -u rai git clone https://gitee.com/tpandmr/running.git /opt/rai
cd /opt/rai
# onnxruntime-node postinstall 需要直连 Nuget 下载构建清单，国内网络常被 302/超时
# 卡住；用 ONNXRUNTIME_NODE_INSTALL=skip 跳过即可（napi-v6 Linux 二进制随包内置）。
sudo -u rai env ONNXRUNTIME_NODE_INSTALL=skip npm ci

sudo mkdir -p /etc/rai
sudo install -m 600 deploy/rai.env.example /etc/rai/rai.env
TOKEN=$(openssl rand -hex 32)
sudo sed -i "s#^RAI_API_TOKEN=.*#RAI_API_TOKEN=$TOKEN#" /etc/rai/rai.env
# 检查所有路径与限额变量符合本机预期后，编辑 /etc/rai/rai.env：
sudoedit /etc/rai/rai.env

# 新站点：先获得证书，再启用引用证书的 HTTPS 配置。
# standalone 需要暂时占用 80 端口；已有站点不要重复运行此首次安装步骤。
sudo systemctl stop nginx
sudo certbot certonly --standalone -d api.example.com
sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo sed "s#rai.example.com#api.example.com#g" deploy/nginx-rai.conf \
  | sed 's/# ssl_certificate /ssl_certificate /; s/# ssl_certificate_key /ssl_certificate_key /' \
  | sudo tee /etc/nginx/sites-available/rai >/dev/null
sudo chmod 600 /etc/nginx/sites-available/rai
sudo ln -sf /etc/nginx/sites-available/rai /etc/nginx/sites-enabled/rai
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable --now rai-api
sudo nginx -t && sudo systemctl restart nginx
# 改为 Nginx 插件进行后续续期，并测试续期流程。
# 若系统自带 Certbot 不支持 reconfigure，先按 Certbot 官方方式升级；
# 不要忽略失败后继续依赖会与运行中 Nginx 抢占 80 端口的 standalone 续期。
sudo certbot reconfigure --cert-name api.example.com --nginx
sudo certbot renew --dry-run
```

把示例中的 `api.example.com` 换成已解析到服务器公网 IP 的域名。若暂时没有域名，可用 HTTP 公网 IP 做连通性测试；正式导入 HealthKit 数据前必须切换 HTTPS。

不要把 API Token 放进任何浏览器或 Web 构建产物：那会把 Token 发布到 JavaScript（前端已退役，但同类错误仍可能以脚本示例形式出现）。iOS 应用在首次连接页（`apps/ios/RAI/Skins/Technology/TechSetupView.swift:45-56` 的「服务地址」与「访问令牌」）填写 HTTPS 地址与同一个 Token，Token 存 Keychain，只由 App 自身的请求携带（含 HealthKit 同步请求），不注入任何页面。设备或账号丢失时应轮换 Token（改 `/etc/rai/rai.env` 的 `RAI_API_TOKEN` 后 `systemctl restart rai-api`）。

### 匿名只读（历史 Web 能力，默认关闭）

该模式原本给浏览器 SPA「打开即看」用；Web 退役后**默认不需要**。保留的代码路径与边界如下，供将来确有匿名只读需求时参考：

默认（`RAI_PUBLIC_HOSTS` 留空）每个 `/v1` 请求都要 Token。

若确需开放匿名读，在 `/etc/rai/rai.env` 里设 `RAI_PUBLIC_HOSTS=<域名>`。效果与边界：

- **公开**：`server.ts` 里 `publicReadRoutes` 列举的读接口（训练列表与不含原始坐标的详情、趋势、统计、训练分区、预测、课表等）。原始轨迹仍需正确令牌。
- **仍需 Token**：所有写请求（`POST/PUT/PATCH/DELETE`），以及 `GET /v1/backups/:name`、`GET /v1/import-sources/*`、`GET /v1/diagnostics`、`GET /v1/openapi.json`、`GET /v1/jobs*`、`GET /v1/import-jobs*`。
- Host 白名单与只读白名单**同时生效**：伪造其它 Host 的匿名读仍返回 401，DNS-rebinding 防护不退化。
- 这是**隐私降级**：知道域名的人仍可看到已公开的健康摘要。`RAI_PUBLIC_HOSTS` 不开放原始轨迹、分享卡或隐私区读路由。
- 未配置 `RAI_API_TOKEN` 时原始轨迹同样默认隐藏；仅本地显式 `RAI_ALLOW_ANONYMOUS_ROUTES=1` 可开启匿名原始轨迹，生产环境不得设置此开关。
- 配套限速在 `deploy/nginx-rai.conf` 的 `limit_req_zone`（300 r/m + burst 100），读接口公开后它是防批量抓取与流量包超额的第一道闸，不要单独关掉。

## 验证

```bash
sudo systemctl status rai-api --no-pager
sudo journalctl -u rai-api -n 100 --no-pager
# 启动日志会打印匿名只读是否开启（"Anonymous read enabled/disabled"），
# 这是判断 RAI_PUBLIC_HOSTS 是否真的生效的唯一可靠方式。
curl -fsS https://api.example.com/v1/health -H "Authorization: Bearer $TOKEN"
# 匿名只读开启后（无 Authorization 头）：
curl -fsS https://api.example.com/v1/health          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/v1/backups   # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: attacker.example' https://api.example.com/v1/health  # 期望 401
# 站点根路径与静态资源已退役：应返回 404
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/                 # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/assets/app.js    # 期望 404
```

## 数据目录与自动备份

- 数据目录：`/var/lib/rai`（`RAI_RUNTIME_ROOT`），主库 `/var/lib/rai/var/rai.sqlite`；
  运行时状态 `/var/lib/rai/var/runtime.sqlite`；导入与报告 `/var/lib/rai/imports/`、
  `/var/lib/rai/reports/`。

### 备份责任边界（2026-10-13 起）

**应用不再创建备份。** `POST /v1/backups` 与 `DELETE /v1/backups/:name` 已退役：
两者都返回 `410 Gone` 与一条维护提示，且**不碰任何文件**；`GET /v1/backups` 只剩只读清单，
恢复入口改由运维用 `POST /v1/backups/:name/restore` 的 curl 流程执行（见
[运维](../docs/OPERATIONS.md)「备份恢复」）。设计边界见
[SQLite直接增量同步](../docs/SQLITE_DIRECT_SYNC_DESIGN.md) §11。

⛔ 因此**不要**再为本机部署 `POST /v1/backups` 的 systemd timer —— 那个接口已退役，
定时任务只会每 40 分钟拿到一次 410。备份改为运维自己的责任：

```bash
# 整 runtime 冷备（停服 → tar → sha256；默认 dry-run，二次确认后加 --apply）
sudo -u rai bash deploy/backup-runtime.sh --output-dir /srv/rai-backups
sudo -u rai bash deploy/backup-runtime.sh --output-dir /srv/rai-backups --apply
```

- 该脚本**停服后**整目录打包，不在运行中的服务上复制 SQLite 文件；输出目录必须在
  runtime 树之外。它打印 `contains private health data; not encrypted`，压缩/加密与异机
  副本请自行在停服窗口之外完成。
- 若确实需要更短停机窗口的**在线**备份，请用 SQLite 一致性备份 API 或与存储协调的快照；
  §11.1 明确：活跃 WAL 库**不能**只 `cp rai.sqlite`，也不得为“提速”删掉 `-wal`/`-shm`。
  在线备份多个库**不**自动等于跨库一致（主库 / runtime / 上传工件 / 配置身份要在同一恢复边界内）。
- 已有备份**不会**被应用删除或自动清理（§11 明令不扫描备份作自动清理）；是否保留、归档、
  删除由运维决定。`var/backups/` 中的备份包含健康数据与精确路线，按主库同等安全等级保管，
  至少保留一份异机或对象存储副本。

## 后续发布新版

推荐用脚本（已把「拉取 → lockfile 变了才 npm ci → 重启并验证真实就绪」
的顺序固化，默认 dry-run，确认后再 `--apply`）：

```bash
cd /opt/rai
sudo bash deploy/upgrade.sh            # 预演，只打印将执行的命令
sudo bash deploy/upgrade.sh --apply    # 执行
```

以下旧式发布命令本身**不包含备份或低内存停服保护**，
2C2G 当前部署应按本页资源预算与维护流程操作：

```bash
cd /opt/rai
sudo -u rai git pull --ff-only origin main
sudo -u rai env ONNXRUNTIME_NODE_INSTALL=skip npm ci
sudo systemctl restart rai-api
```

数据（`/var/lib/rai`）不受发布影响；若 `apps/api/package.json` 依赖变化，务必重新 `npm ci`。

## 安全与运维备注

- 保持端口 `8787` 关闭，仅暴露 80/443：先 `sudo ufw allow OpenSSH`，再
  `sudo ufw allow 80,443/tcp && sudo ufw enable`，避免锁死 SSH。
- 若服务端 Nginx 站点按域名（SNI）分流且域名被云厂商备案拦截，可启用
  `deploy/nginx-rai.conf` 注释中的 `rai-ip`（IP 自签证书 + iPhone 安装
  `RAI-IP-CA.mobileconfig`）站点，备案通过后再改回域名。
- 重大变更前建议先在腾讯云控制台打快照；此外用 `deploy/backup-runtime.sh` 做整 runtime
  冷备（应用不再代做备份，见上面的「备份责任边界」）。


## 显式数据库迁移（2026-09-17 起）

API 与后台 worker 不再自动迁移主库。API 启动发现待迁移版本或待修复的旧迁移元数据时退出 **78**；缺失主库仍保留首次导入/维护入口。默认 `data:migrate` 仅只读预演，必须指定目标库。

```bash
cd /opt/rai
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite
# 先由运维自行完成保护（应用不再代做备份，POST /v1/backups 已退役回 410）：
sudo -u rai bash deploy/backup-runtime.sh --output-dir /srv/rai-backups --apply
sudo systemctl stop rai-api
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite --apply
# 成功后解除可能已触发的启动频率限制，并启动：
sudo systemctl reset-failed rai-api
sudo systemctl start rai-api
curl -fsS http://127.0.0.1:8787/v1/health -H "Authorization: Bearer $RAI_API_TOKEN"
```

健康响应必须同时包含 `status: "ok"` 和 `databaseReady: true`，HTTP 200/服务 active 不足以证明就绪。CLI 与 API 共用 publication lock；不要在 API 运行时执行 `--apply`，不要手工删除活进程锁。

发布脚本可显式加入 `--apply --migrate --database /var/lib/rai/var/rai.sqlite`：更新代码和构建完成后，停服、迁移、重启并检查真实就绪；迁移失败保持停止。**脚本本身不再做在线备份**（只打印外部备份责任提示，且不校验运维是否已完成），所以加 `--migrate` 之前请先自行备份。不加 `--migrate` 不会自动升级库。首次引入本变更时应先更新部署机脚本，再执行该选项。

同时更新 systemd unit（保留本机已有的必要定制）：`[Unit]` 段的 `StartLimitIntervalSec=300`、`StartLimitBurst=3`，以及 `[Service]` 段的 `RestartPreventExitStatus=78`，然后 `sudo systemctl daemon-reload`。仅改仓库文件不会更新已安装的 unit。

迁移按**单个版本**事务提交，不是全序列事务；失败后不要假设已恢复到最初版本。自动迁移备份位于 `dirname(database)/backups`；维护 API 备份位于 `RAI_RUNTIME_ROOT/var/backups`（默认两者相同，自定义数据库路径时可能不同）。空间预检只是最低备份空间门槛，不保证迁移峰值空间足够。恢复到旧 schema 后必须同时匹配旧版应用，或重新显式迁移；不能用新 API 的拒绝策略直接启动旧库。

## 用户体验版本的发布核验（2026-09-28）

先发布兼容 API，再发布 iOS；本次用户体验改动不新增数据库迁移。摘要导出接口 `/v1/exports/workout-summary` 即使在公开 Host 下也要求配置并携带 `RAI_API_TOKEN`，不要为解决导出失败扩大匿名读取权限。

可在服务器运行 `bash deploy/check-runtime-readonly.sh` 收集只读运行证据；脚本不重启服务、不迁移、不输出令牌。它不能代替 TLS 检查、实际任务引擎核验或完整运行时恢复演练。环境变量只证明配置意图，备份文件存在也不证明能够完整恢复。

如果 `RAI_PUBLIC_HOSTS` 非空，仍需单独核实健康数据和路线的匿名可见性。本地代码审查不代表已登录服务器核对配置；发布/设备验收见[运维](../docs/OPERATIONS.md)及[iOS runbook](../docs/IOS_NATIVE_RUNBOOK.md)。

### 运维脚本的执行边界（2026-09-28 审计修订）

`deploy/check-runtime-readonly.sh` 是明确保留的**人工运维入口**，不进入自动生产门禁，也不由客户端、API 启动或部署脚本自动执行。发布负责人应在目标 Linux/systemd 服务器上运行 `bash deploy/check-runtime-readonly.sh` 并归档输出；非 Linux 环境退出 2 表示“未核验”，不是通过。自动测试仅验证脚本语法和非 Linux 的拒绝路径，不能替代生产运行、TLS/实际引擎检查或恢复演练。

## 资源预算与一致性维护

### HealthKit data-only 快通路（2026-10-12）

本批新增 schema v33：为 UUID 别名修复增加来源索引。部署新 API 前按本页既有
显式迁移流程备份、停服、迁移并检查 `databaseReady`；不能在 API 运行期间直接建索引。
`RAI_IMPORT_DATA_ONLY_FAST_PATH=1` 是默认值；`0`（并重启服务）会**暂停同步入口**——
直连车道以 `fast_path_disabled` 显式失败（稳定码 `direct_sync_unavailable`），**不再回退任何
候选路径**：旧的整库备份 / 暂存副本 / CLI 换库链路已随服务端收口版从运行期删除（2026-10-14，阶段 3）。
开关不改变同步身份、删除语义或客户端游标。超界批次同理显式拒绝
（`direct_sync_payload_exceeds_bounds`），不静默降级。适用范围与故障回滚合同见
[HealthKit 记录同步 v2](../docs/HEALTHKIT_RECORD_SYNC_V2.md)。
空库首包会**就地初始化**身份（bootstrap）；库里已有身份痕迹但与当前契约/身份算法不符时，
显式报 `direct_sync_baseline_rebuild_required`（需运维 CLI 重建或回退服务端版本）——
不能把部署成功等同于下一批必定通过。

配置依据：[systemd service](rai-api.service)、[env模板](rai.env.example)、[Nginx](nginx-rai.conf)。
MemoryHigh=1100M、MemoryMax=1400M、MemorySwapMax=512M、CPUQuota=150%；Node堆每进程512MiB，数值库线程1。
这些是初始预算，不保证任意规模健康导出能在2GB内完成；swap限制不等于主机已有swap。
先检查磁盘、内存和实际cgroup生效值，不关闭质量门禁换吞吐。
不迁移N100、不安装FRP、不新增第二个可写主库。可选Rust路径见[Rust说明](../docs/RUST_DATA_ENGINE.md)，不能只改env而不部署匹配工件。

升级前停手机同步、等待任务结束、禁止独立CLI写者，保留代码/环境/身份配置和回滚版本。
[backup-runtime.sh](backup-runtime.sh)默认dry-run，对整个runtime做冷备；所有自定义DB/工件目录都需纳入实际备份范围。

```bash
sudo install -d -m 700 /var/backups/rai
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai
# 确认路径、空间、服务状态和维护窗口后才执行：
sudo bash deploy/backup-runtime.sh --output-dir /var/backups/rai --apply
```

备份结束会恢复原服务状态；升级迁移前再明确停服。迁移默认检查、显式apply，流程见[运维](../docs/OPERATIONS.md)。
不要把旧二进制与新schema的兼容视为当然成立；先在副本验证、保存工件，启动后核对身份、读写、队列和恢复能力。
不能对运行中WAL主库作普通文件复制；备份和配置含敏感信息，须严格权限并离线保护。
