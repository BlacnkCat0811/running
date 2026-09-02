# Ubuntu 部署

应用只监听 `127.0.0.1:8787`，由 Nginx 提供 HTTPS。SQLite、上传文件和备份放在 `/var/lib/rai`，不要把该目录放到 Web 根目录或共享盘。

```bash
sudo useradd --system --home /opt/rai --shell /usr/sbin/nologin rai
sudo mkdir -p /opt/rai /var/lib/rai
sudo chown -R rai:rai /opt/rai /var/lib/rai
sudo apt-get install -y nginx certbot python3-certbot-nginx nodejs npm
sudo -u rai git clone <repo-url> /opt/rai
cd /opt/rai && sudo -u rai npm ci && sudo -u rai npm run build
sudo install -m 600 deploy/rai.env.example /etc/rai/rai.env
sudoedit /etc/rai/rai.env
sudo install -m 644 deploy/rai-api.service /etc/systemd/system/rai-api.service
sudo install -m 644 deploy/nginx-rai.conf /etc/nginx/sites-available/rai
sudo ln -s /etc/nginx/sites-available/rai /etc/nginx/sites-enabled/rai
sudo nginx -t && sudo systemctl daemon-reload
sudo systemctl enable --now rai-api
sudo certbot --nginx -d rai.example.com
```

Set `RAI_API_TOKEN` to a random value (`openssl rand -hex 32`). Replace the placeholder in the Nginx config with the same value, then create the web login with `sudo htpasswd -c /etc/nginx/.htpasswd-rai your-user`. Do not put the API token in Web build environment variables: that would publish it in JavaScript. If the iOS shell is used against this deployment, enter the HTTPS URL and the same token in its server settings. Rotate both the token and htpasswd entry when a device or account is lost.

Back up `/var/lib/rai/var` separately. Keep port 8787 closed in the firewall; expose only 80/443 and use `sudo ufw allow 80,443/tcp`.
