# Remote Mode Quickstart

远程模式适合下面这种场景：

- 你想在本地机器运行 `codex`
- 本地机器不想暴露公网端口
- 你愿意单独部署一个有公网入口的 `remote-client`

## 架构

- `remote-client`：公网 hub，提供 HTTP API
- `remote-server`：本地 agent，主动连接 `remote-client`

控制链路是：

1. 你调用 `remote-client`
2. `remote-client` 通过长连接把命令发给 `remote-server`
3. `remote-server` 在本地执行 `codex`
4. 执行结果回传给 `remote-client`

## 1. 启动 remote-client

在公网机器配置：

```dotenv
REMOTE_CLIENT_HOST=0.0.0.0
REMOTE_CLIENT_PORT=8789
REMOTE_SHARED_SECRET=replace_me
REMOTE_CLIENT_API_TOKEN=replace_me
```

启动：

```bash
npm install
npm run start:remote-client
```

## 2. 启动 remote-server

在本地 Codex 机器配置：

```dotenv
REMOTE_CLIENT_URL=https://your-client.example.com
REMOTE_SERVER_ID=my-laptop
REMOTE_SHARED_SECRET=replace_me

CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

启动：

```bash
npm install
npm run start:remote-server
```

说明：

- `REMOTE_CLIENT_URL` 指向公网 `remote-client`
- `REMOTE_SHARED_SECRET` 要和 `remote-client` 一致
- `REMOTE_SERVER_ID` 用来区分不同本地机器

## 3. 检查是否连上

```bash
curl -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  http://127.0.0.1:8789/remote/api/servers
```

如果正常，你会看到在线的 `server_id` 列表。

## 4. 远程执行一次 Codex

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/run \
  -d '{
    "server_id": "my-laptop",
    "chat_key": "demo-chat",
    "text": "帮我看下当前仓库结构"
  }'
```

字段说明：

- `server_id`：目标本地机器
- `chat_key`：会话 key，决定 session 复用粒度
- `text`：发给 Codex 的用户消息

## 5. 查看状态和重置

查看状态：

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/status \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

重置 session：

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/reset \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

## 说明

- 同一个 `chat_key` 会串行执行
- session/thread 保存在 `remote-server` 本地
- `remote-server` 不需要暴露公网端口
- 当前远程模式是通用 API，不依赖 Telegram 或飞书
