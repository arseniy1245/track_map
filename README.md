# Map Routes

Веб-карта для загрузки и хранения маршрутов GPX / GeoJSON. Приложение запускается на Node.js, хранит данные локально в папке `storage/` и поддерживает отдельных пользователей с отдельными маршрутами.

## Что нужно

- Удаленный сервер с Ubuntu 22.04 / 24.04 или похожим Linux-дистрибутивом.
- Доступ по SSH.
- Node.js `18` или новее.
- Git.
- Nginx, если приложение должно открываться по домену или через 80/443 порт.

## Быстрый локальный запуск

```bash
npm ci
npm start
```

После запуска приложение будет доступно на:

```text
http://localhost:3000
```

Порт можно изменить:

```bash
PORT=8080 npm start
```

## Запуск через готовые скрипты

Для установки зависимостей:

```bash
chmod +x install.sh start-server.sh
./install.sh
```

Для запуска сервера:

```bash
./start-server.sh
```

По умолчанию сервер запускается на порту `3000`. Другой порт:

```bash
PORT=8080 ./start-server.sh
```

## Установка на пустой удаленный сервер

Дальше пример для Ubuntu. Подключитесь к серверу:

```bash
ssh root@SERVER_IP
```

Обновите пакеты и поставьте базовые утилиты:

```bash
apt update
apt upgrade -y
apt install -y curl git nginx ufw
```

Установите Node.js 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

Проверьте версии:

```bash
node -v
npm -v
```

Создайте отдельного пользователя для приложения:

```bash
adduser --system --group --home /opt/map-routes maproutes
```

Скачайте проект в `/opt/map-routes`:

```bash
git clone REPOSITORY_URL /opt/map-routes
cd /opt/map-routes
```

Если проекта еще нет в git-репозитории, можно загрузить файлы с локального компьютера:

```bash
scp -r ./Map_routes root@SERVER_IP:/opt/map-routes
```

Поставьте зависимости:

```bash
cd /opt/map-routes
npm ci
```

Создайте папку для данных и выдайте права:

```bash
mkdir -p /opt/map-routes/storage
chown -R maproutes:maproutes /opt/map-routes
```

## Проверка ручного запуска

```bash
cd /opt/map-routes
PORT=3000 npm start
```

В другом SSH-окне проверьте:

```bash
curl http://127.0.0.1:3000/api/users
```

Если вернулся JSON со списком пользователей, сервер работает. Остановите ручной запуск через `Ctrl+C`.

## Запуск через systemd

Создайте сервис:

```bash
nano /etc/systemd/system/map-routes.service
```

Вставьте:

```ini
[Unit]
Description=Map Routes Node.js app
After=network.target

[Service]
Type=simple
User=maproutes
Group=maproutes
WorkingDirectory=/opt/map-routes
Environment=PORT=3000
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Включите и запустите сервис:

```bash
systemctl daemon-reload
systemctl enable map-routes
systemctl start map-routes
```

Проверьте статус:

```bash
systemctl status map-routes
```

Посмотреть логи:

```bash
journalctl -u map-routes -f
```

## Настройка Nginx

Создайте конфиг:

```bash
nano /etc/nginx/sites-available/map-routes
```

Для домена:

```nginx
server {
    listen 80;
    server_name example.com www.example.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Для доступа просто по IP замените строку `server_name`:

```nginx
server_name SERVER_IP;
```

Включите сайт:

```bash
ln -s /etc/nginx/sites-available/map-routes /etc/nginx/sites-enabled/map-routes
nginx -t
systemctl reload nginx
```

## Firewall

Разрешите SSH и HTTP:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
ufw status
```

После этого приложение должно открываться:

```text
http://example.com
```

или:

```text
http://SERVER_IP
```

## HTTPS через Let's Encrypt

Если используется домен, установите Certbot:

```bash
apt install -y certbot python3-certbot-nginx
```

Выпустите сертификат:

```bash
certbot --nginx -d example.com -d www.example.com
```

Проверьте автообновление:

```bash
certbot renew --dry-run
```

## Где хранятся данные

Все пользовательские данные лежат в:

```text
/opt/map-routes/storage
```

Внутри:

```text
storage/users.json
storage/users/<user-id>/routes.json
storage/users/<user-id>/routes/*.gpx
storage/users/<user-id>/routes/*.geojson
storage/tile-cache/
```

Важно: `storage/` не нужно коммитить в git. Это реальные данные пользователей и маршрутов.

## Резервная копия

Минимальный бэкап:

```bash
tar -czf map-routes-storage-backup.tar.gz -C /opt/map-routes storage
```

Восстановление:

```bash
systemctl stop map-routes
tar -xzf map-routes-storage-backup.tar.gz -C /opt/map-routes
chown -R maproutes:maproutes /opt/map-routes/storage
systemctl start map-routes
```

## Обновление приложения

Если проект развернут через git:

```bash
cd /opt/map-routes
git pull
npm ci
chown -R maproutes:maproutes /opt/map-routes
systemctl restart map-routes
```

Проверьте логи:

```bash
journalctl -u map-routes -n 100 --no-pager
```

## Полезные команды

Перезапустить приложение:

```bash
systemctl restart map-routes
```

Остановить:

```bash
systemctl stop map-routes
```

Посмотреть последние логи:

```bash
journalctl -u map-routes -n 100 --no-pager
```

Проверить, слушает ли сервер порт:

```bash
ss -ltnp | grep 3000
```

Проверить API:

```bash
curl http://127.0.0.1:3000/api/users
```

## Частые проблемы

### 502 Bad Gateway в Nginx

Проверьте, запущен ли Node.js-сервис:

```bash
systemctl status map-routes
journalctl -u map-routes -n 100 --no-pager
```

Проверьте, что приложение отвечает локально:

```bash
curl http://127.0.0.1:3000
```

### Не загружаются большие GPX-файлы

В конфиге Nginx должен быть параметр:

```nginx
client_max_body_size 50m;
```

После изменения конфига:

```bash
nginx -t
systemctl reload nginx
```

### После перезагрузки сервера приложение не стартует

Проверьте, включен ли автозапуск:

```bash
systemctl is-enabled map-routes
systemctl enable map-routes
```

### Нет прав на запись в storage

```bash
chown -R maproutes:maproutes /opt/map-routes/storage
systemctl restart map-routes
```
