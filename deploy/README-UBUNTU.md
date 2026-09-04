# Ubuntu 部署

应用只监听 `127.0.0.1:8787`，由 Nginx 提供 HTTPS。SQLite、上传文件和备份放在 `/var/lib/rai`，不要把该目录放到 Web 根目录或共享盘。

以下步骤适用于腾讯云 Ubuntu 22.04/24.04。先在腾讯云安全组开放 TCP `22`（仅你的办公 IP）、`80`、`443`，不要开放 `8787`。

```bash
sudo useradd --system --home /opt/rai --shell /usr/sbin/nologin rai
sudo mkdir -p /opt/rai /var/lib/rai
sudo chown -R rai:rai /opt/rai /var/lib/rai
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx apache2-utils openssl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # 必须是 v22.12.0 或更高的 22.x
sudo -u rai git clone https://gitee.com/tpandmr/running.git /opt/rai
cd /opt/rai && sudo -u rai npm ci && sudo -u rai npm run build
sudo mkdir -p /etc/rai
sudo install -m 600 deploy/rai.env.example /etc/rai/rai.env
TOKEN=$(openssl rand -hex 32)
sudo sed -i "s#^RAI_API_TOKEN=.*#RAI_API_TOKEN=$TOKEN#" /etc/rai/rai.env
sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo sed "s#rai.example.com#api.example.com#g; s#replace-with-the-same-token-as-/etc/rai/rai.env#$TOKEN#" \
  deploy/nginx-rai.conf | sudo tee /etc/nginx/sites-available/rai >/dev/null
sudo chmod 600 /etc/nginx/sites-available/rai
sudo ln -sf /etc/nginx/sites-available/rai /etc/nginx/sites-enabled/rai
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable --now rai-api
sudo nginx -t && sudo systemctl restart nginx
sudo certbot --nginx --redirect -d api.example.com
```

把示例中的 `api.example.com` 换成已解析到服务器公网 IP 的域名。证书申请前必须确保域名已经解析并且安全组开放 80。若暂时没有域名，先使用 HTTP 公网 IP 做连通性测试，正式导入 HealthKit 数据前必须切换 HTTPS。不要把 API token 放入 Web build 环境变量：那会把 token 发布到 JavaScript。Web 页面可以直接打开，所有 `/v1/` API 请求都必须携带 Bearer Token；Nginx 会为浏览器请求注入该 token，iOS shell 则在设置中填写同一个 token。设备或账号丢失时轮换 token。

验证命令：

```bash
sudo systemctl status rai-api --no-pager
sudo journalctl -u rai-api -n 100 --no-pager
curl -fsS https://api.example.com/v1/health -H "Authorization: Bearer $TOKEN"
```

备份 `/var/lib/rai/var`（至少保留异机或对象存储副本）。保持端口 8787 关闭，仅暴露 80/443：先执行 `sudo ufw allow OpenSSH`，再执行 `sudo ufw allow 80,443/tcp && sudo ufw enable`，避免锁死 SSH。

后续发布新版：

```bash
cd /opt/rai
sudo -u rai git pull --ff-only origin main
sudo -u rai npm ci
sudo -u rai npm run build
sudo systemctl restart rai-api
```
