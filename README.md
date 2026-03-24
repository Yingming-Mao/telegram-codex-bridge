# Telegram / Feishu Codex Bridge

[中文说明](README_zh.md)

One repo, one root `.env`, one `npm start`.

This project bridges Telegram or Feishu/Lark messages into Codex CLI sessions. Telegram and Feishu share the same Codex runtime core; only the platform adapter differs.

## Recent Changes

- Added Feishu/Lark support with persistent connection and webhook modes
- Unified root entrypoint with `BRIDGE_PLATFORM=telegram|feishu`
- Added shared Codex runtime core for Telegram and Feishu adapters
- Improved rich-text rendering for Telegram and Feishu replies

## Choose A Platform

Set `BRIDGE_PLATFORM` in the root `.env`:

- `telegram`
- `feishu`

Then start from the repo root:

```bash
npm install
cp .env.example .env
npm start
```

If you omit `BRIDGE_PLATFORM`, the bridge will auto-detect:

- `feishu` when `FEISHU_APP_ID` is set and `TELEGRAM_BOT_TOKEN` is unset
- otherwise `telegram`

## Feishu / Lark

Example:

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

Recommended for local development:

- `FEISHU_SUBSCRIPTION_MODE=websocket`
- In Feishu console choose `Receive events through persistent connection`

Use webhook only if you already have a public callback URL:

```dotenv
FEISHU_SUBSCRIPTION_MODE=webhook
FEISHU_VERIFICATION_TOKEN=replace_me
FEISHU_WEBHOOK_HOST=127.0.0.1
FEISHU_WEBHOOK_PORT=3000
FEISHU_WEBHOOK_PATH=/feishu/events
```

Feishu features:

- Persistent connection or webhook
- Private-chat allowlist
- Group policy and `@mention` gating
- Approximate streaming updates from Codex JSON events
- `/start`, `/status`, `/reset`

Detailed Feishu setup remains in [adapters/feishu/README.md](adapters/feishu/README.md), but you no longer need to start from that subdirectory. Root `npm start` will hand off to the Feishu adapter when `BRIDGE_PLATFORM=feishu`.

## Telegram

Example:

```dotenv
BRIDGE_PLATFORM=telegram
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
```

Features:

- Telegram private chat bot
- Photo/document download support
- `/start`, `/status`, `/reset`

## Shared Configuration

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

## Notes

- Telegram uses the root adapter directly.
- Feishu currently runs through the maintained adapter under [adapters/feishu](adapters/feishu), but from the user's point of view the entrypoint is unified at the repo root.
- This does not attach to an already-open Codex TUI session.

## Check

Root:

```bash
npm run check
```

Feishu adapter:

```bash
cd adapters/feishu
npm run check
```
