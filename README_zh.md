# Telegram / Feishu Codex Bridge

[English](README.md)

一个仓库，一份根目录 `.env`，一个 `npm start`。

这个项目把 Telegram 或飞书 / Lark 消息桥接到 Codex CLI。Telegram 和飞书共用同一套 Codex runtime core，只在平台接入层不同。

## 最近更新

- 新增飞书 / Lark 支持，包含长连接和 webhook 两种模式
- 统一根目录入口，通过 `BRIDGE_PLATFORM=telegram|feishu` 选择平台
- 抽出 Telegram 和飞书共享的 Codex runtime core
- 改进 Telegram 和飞书回包的富文本显示

## 先选平台

在根目录 `.env` 里设置：

- `BRIDGE_PLATFORM=telegram`
- `BRIDGE_PLATFORM=feishu`

然后都从仓库根目录启动：

```bash
npm install
cp .env.example .env
npm start
```

如果你不写 `BRIDGE_PLATFORM`，程序会自动判断：

- 设置了 `FEISHU_APP_ID` 且没设置 `TELEGRAM_BOT_TOKEN` 时，走 `feishu`
- 其他情况默认走 `telegram`

## 飞书 / Lark

示例：

```dotenv
BRIDGE_PLATFORM=feishu
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
FEISHU_ALLOW_FROM=ou_xxx
FEISHU_SUBSCRIPTION_MODE=websocket
```

本地开发推荐：

- `FEISHU_SUBSCRIPTION_MODE=websocket`
- 飞书后台选左边 `Receive events through persistent connection`

只有在你已经有公网回调地址时，才建议用 webhook：

```dotenv
FEISHU_SUBSCRIPTION_MODE=webhook
FEISHU_VERIFICATION_TOKEN=replace_me
FEISHU_WEBHOOK_HOST=127.0.0.1
FEISHU_WEBHOOK_PORT=3000
FEISHU_WEBHOOK_PATH=/feishu/events
```

飞书能力：

- 支持长连接和 webhook
- 私聊 allowlist
- 群策略和 `@mention`
- 基于 Codex JSON 事件流的近似 streaming
- `/start`、`/status`、`/reset`

更详细的飞书接入说明还在 [adapters/feishu/README.md](adapters/feishu/README.md)，但现在你已经不需要去那个子目录启动了。只要根目录 `BRIDGE_PLATFORM=feishu`，`npm start` 会自动切到飞书 adapter。

## Telegram

示例：

```dotenv
BRIDGE_PLATFORM=telegram
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
```

特点：

- Telegram 私聊 bot
- 支持图片/文档下载
- `/start`、`/status`、`/reset`

## 共享配置

- `CODEX_WORKDIR`
- `CODEX_BIN`
- `CODEX_FULL_AUTO`
- `CODEX_SANDBOX`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `CODEX_SKIP_GIT_REPO_CHECK`
- `MAX_PROMPT_CHARS`
- `MAX_OUTPUT_CHARS`
- `BRIDGE_STATE_DIR`

## 说明

- Telegram 直接使用根目录 adapter。
- 飞书目前内部仍复用 [adapters/feishu](adapters/feishu) 里的已验证 adapter，但对用户来说入口已经统一成根目录。
- 这不是挂到你当前已经打开的 Codex TUI 对话上。

## 检查

根目录：

```bash
npm run check
```

飞书 adapter：

```bash
cd adapters/feishu
npm run check
```
