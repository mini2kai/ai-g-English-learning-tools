#!/usr/bin/env bash
set -euo pipefail

DOMAIN="zeke0419.top"
UPSTREAM="127.0.0.1:18080"
EMAIL="1095035409@qq.com"  # 修改为你的邮箱

# 可选：为同一域名增加“路径分发”到其它后端
# 仅修改 EXTRA_PORT 即可默认生成 /app${EXTRA_PORT} -> 127.0.0.1:${EXTRA_PORT}
# 如需自定义路径，设置 EXTRA_PATH（例如 "/app2"）
EXTRA_PORT=""
EXTRA_PATH=""

# 停止可能占用80/443的服务（如存在）
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

apt update
apt install -y nginx certbot python3-certbot-nginx

# 写入站点配置
cat >/etc/nginx/sites-available/${DOMAIN} <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  client_max_body_size 10m;

  location / {
    proxy_pass http://${UPSTREAM};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location ^~ /assets/ {
    proxy_pass http://${UPSTREAM};
    expires 30d;
    add_header Cache-Control "public, max-age=2592000";
  }
}
EOF

# 启用站点并检测
ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# 放行端口
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80 || true
  ufw allow 443 || true
fi

# 非交互签发并自动改写HTTPS跳转
certbot --nginx -d ${DOMAIN} --agree-tos -m ${EMAIL} --redirect --no-eff-email -n

# 可选：添加路径分发（/app{EXTRA_PORT} 或自定义 EXTRA_PATH）
if [ -n "${EXTRA_PORT}" ]; then
  EXTRA_PATH_FINAL="${EXTRA_PATH}"
  if [ -z "${EXTRA_PATH_FINAL}" ]; then
    EXTRA_PATH_FINAL="/app${EXTRA_PORT}"
  fi
  SNIPPET="/etc/nginx/snippets/${DOMAIN}_routes.conf"
  mkdir -p /etc/nginx/snippets
  # 生成/追加 location 块（幂等）
  if ! grep -q "location ${EXTRA_PATH_FINAL}/" "${SNIPPET}" 2>/dev/null; then
    cat >>"${SNIPPET}" <<EOF
  # extra route ${EXTRA_PATH_FINAL} -> 127.0.0.1:${EXTRA_PORT}
  location ${EXTRA_PATH_FINAL}/ {
    proxy_pass http://127.0.0.1:${EXTRA_PORT}/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
EOF
  fi

  # 读取证书路径（由 certbot 写入 live 目录）
  CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  # 重写站点文件：标准化 80/443，并在 443 引入 snippet
  cat >"/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${DOMAIN};

  ssl_certificate ${CERT};
  ssl_certificate_key ${KEY};
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  client_max_body_size 10m;

  location / {
    proxy_pass http://${UPSTREAM};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location ^~ /assets/ {
    proxy_pass http://${UPSTREAM};
    expires 30d;
    add_header Cache-Control "public, max-age=2592000";
  }

  include ${SNIPPET};
}
EOF
  ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
  nginx -t
  systemctl reload nginx
fi

# 验证
echo "Check HTTP: "
curl -I http://${DOMAIN} || true
echo "Check HTTPS: "
curl -I https://${DOMAIN} || true

echo "Done. Open: https://${DOMAIN}/"