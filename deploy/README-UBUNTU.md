# Ubuntu 部署

应用只监听 `127.0.0.1:8787`（`RAI_API_HOST` / `RAI_API_PORT` 可覆盖），由 Nginx 提供 HTTPS 并托管静态 Web。SQLite、上传文件、运行时状态和备份放在 `/var/lib/rai`，不要把该目录放到 Web 根目录或共享盘。

本页描述与线上生产（2026-09）一致的 v2 拓扑：

- Nginx 直接托管 `apps/web/dist`（SPA，`try_files` 回退到 `index.html`）；
- 仅 `location /v1/` 反代到 `127.0.0.1:8787`，**透传客户端自己的 Bearer Token**；
- 不做 `auth_basic`、不做 Nginx 侧 Token 注入（WKWebView 无法处理 Basic Auth 弹窗，且注入会让 iOS 壳自带 Token 失效）；
- 后端 `apps/api/src/local-request-security.ts` 统一校验 Bearer 与请求上下文。

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
node --version  # 必须是 v22.12.0 或更高的 22.x

sudo -u rai git clone https://gitee.com/tpandmr/running.git /opt/rai
cd /opt/rai
# onnxruntime-node postinstall 需要直连 Nuget 下载构建清单，国内网络常被 302/超时
# 卡住；用 ONNXRUNTIME_NODE_INSTALL=skip 跳过即可（napi-v6 Linux 二进制随包内置）。
sudo -u rai env ONNXRUNTIME_NODE_INSTALL=skip npm ci
sudo -u rai npm run build

sudo mkdir -p /etc/rai
sudo install -m 600 deploy/rai.env.example /etc/rai/rai.env
TOKEN=$(openssl rand -hex 32)
sudo sed -i "s#^RAI_API_TOKEN=.*#RAI_API_TOKEN=$TOKEN#" /etc/rai/rai.env
# 检查所有路径与限额变量符合本机预期后，编辑 /etc/rai/rai.env：
sudoedit /etc/rai/rai.env

sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo sed "s#rai.example.com#api.example.com#g" deploy/nginx-rai.conf \
  | sudo tee /etc/nginx/sites-available/rai >/dev/null
sudo chmod 600 /etc/nginx/sites-available/rai
sudo ln -sf /etc/nginx/sites-available/rai /etc/nginx/sites-enabled/rai
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable --now rai-api
sudo nginx -t && sudo systemctl restart nginx
# 证书签发前确保域名已解析到本机公网 IP、安全组开放 80
sudo certbot --nginx --redirect -d api.example.com
```

把示例中的 `api.example.com` 换成已解析到服务器公网 IP 的域名。若暂时没有域名，可用 HTTP 公网 IP 做连通性测试；正式导入 HealthKit 数据前必须切换 HTTPS。

不要把 API Token 放入 Web build 环境变量：那会把 Token 发布到 JavaScript。iOS 调试壳（WKWebView）在服务器设置中填写 HTTPS 地址与同一个 Token，由壳把 Token 注入页面与 HealthKit 同步请求；桌面浏览器直接打开站点能加载页面，但 `/v1/` 请求因没有 Token 会返回 401（符合预期，正式使用以 iOS 壳为主）。设备或账号丢失时应轮换 Token（改 `/etc/rai/rai.env` 的 `RAI_API_TOKEN` 后 `systemctl restart rai-api`）。

## 验证

```bash
sudo systemctl status rai-api --no-pager
sudo journalctl -u rai-api -n 100 --no-pager
curl -fsS https://api.example.com/v1/health -H "Authorization: Bearer $TOKEN"
# SPA 与深链接
curl -fsSI https://api.example.com/
curl -fsSI https://api.example.com/settings
```

## 数据目录与自动备份

- 数据目录：`/var/lib/rai`（`RAI_RUNTIME_ROOT`），主库 `/var/lib/rai/var/rai.sqlite`；
  运行时状态 `/var/lib/rai/var/runtime.sqlite`；备份 `/var/lib/rai/backups/`；
  导入与报告 `/var/lib/rai/imports/`、`/var/lib/rai/reports/`。
- 应用自带一致性备份：`POST /v1/backups`（node:sqlite `backup()`），保留策略由
  `RAI_BACKUP_MAX_COUNT` / `RAI_BACKUP_MAX_TOTAL_BYTES` / `RAI_BACKUP_MIN_FREE_BYTES`
  控制（代码默认 10 份 / 20 GiB / 512 MiB；`rai.env.example` 预置 14 份 / 10 GiB）。
- 建议用 systemd timer 定时触发（线上同款）：

```bash
sudo tee /etc/systemd/system/rai-backup.service >/dev/null <<'EOF'
[Unit]
Description=RAI periodic consistency backup
After=network-online.target rai-api.service

[Service]
Type=oneshot
User=rai
EnvironmentFile=/etc/rai/rai.env
ExecStart=/usr/bin/curl -fsS -X POST http://127.0.0.1:8787/v1/backups -H "Authorization: Bearer ${RAI_API_TOKEN}"
EOF
sudo tee /etc/systemd/system/rai-backup.timer >/dev/null <<'EOF'
[Unit]
Description=RAI backup timer (every 40 minutes)

[Timer]
OnBootSec=3min
OnUnitActiveSec=40min
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now rai-backup.timer
```

- 至少保留一份异机或对象存储副本；`var/backups/` 中的备份包含健康数据与精确路线，按主库同等安全等级保管。

## 后续发布新版

推荐用脚本（已把「先备份、再拉取、lockfile 变了才 npm ci」的顺序固化，
默认 dry-run，确认后再 `--apply`）：

```bash
cd /opt/rai
sudo bash deploy/upgrade.sh            # 预演，只打印将执行的命令
sudo bash deploy/upgrade.sh --apply    # 执行
```

手敲等价步骤（脚本做了同样的事）：

```bash
cd /opt/rai
sudo -u rai git pull --ff-only origin main
sudo -u rai env ONNXRUNTIME_NODE_INSTALL=skip npm ci
sudo -u rai npm run build
sudo systemctl restart rai-api
```

数据（`/var/lib/rai`）不受发布影响；若 `apps/api/package.json` 依赖变化，务必重新 `npm ci`。

## 安全与运维备注

- 保持端口 `8787` 关闭，仅暴露 80/443：先 `sudo ufw allow OpenSSH`，再
  `sudo ufw allow 80,443/tcp && sudo ufw enable`，避免锁死 SSH。
- 若服务端 Nginx 站点按域名（SNI）分流且域名被云厂商备案拦截，可启用
  `deploy/nginx-rai.conf` 注释中的 `rai-ip`（IP 自签证书 + iPhone 安装
  `RAI-IP-CA.mobileconfig`）站点，备案通过后再改回域名。
- 重大变更前建议先在腾讯云控制台打快照；云快照配额有限时，优先依赖上面的
  40 分钟应用级备份。
