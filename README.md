# Telegram Codex Bridge

[中文说明](README_zh.md)

Telegram bot bridge for Codex CLI sessions.

Codex CLI does not currently expose a native Telegram inbound channel, so this project runs as a standalone bridge that receives Telegram private messages, maps each chat to its own Codex thread, and sends the final Codex reply back to Telegram.

## Message Flow

```text
Telegram User
    |
    v
Telegram Bot API
    |
    v
telegram-codex-bridge
    |- validates ALLOWED_TELEGRAM_USER_IDS
    |- saves attachments to local inbox
    |- loads/saves per-chat state
    |
    v
codex exec / codex exec resume
    |
    v
Codex final reply
    |
    v
telegram-codex-bridge
    |
    v
Telegram Bot API
    |
    v
Telegram User
```

## Features

- Control Codex from a Telegram private chat
- Restrict access with `ALLOWED_TELEGRAM_USER_IDS`
- Reuse the same Codex session across multiple turns
- Save photo inputs locally and pass them to Codex
- Save document inputs locally and include file paths in the prompt
- Built-in `/start`, `/status`, and `/reset` commands
- Telegram API proxy support

## Limitations

- This does not attach to an already-open Codex TUI session
- Every Telegram message still triggers a CLI invocation
- Only private chats are supported for now
- Real task execution still depends on local Codex login state, sandbox, and permissions

## Requirements

- Node.js 20+
- A working local `codex` CLI
- A Telegram bot token from `@BotFather`
- Your Telegram user ID

## Quick Start

```bash
cd /path/to/telegram-codex-bridge
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
# TELEGRAM_PROXY_URL=http://127.0.0.1:7890
```

Start the bridge:

```bash
npm start
```

Expected startup output:

```text
telegram-codex-bridge: polling as @your_bot_name
telegram-codex-bridge: workdir /abs/path/to/your/project
telegram-codex-bridge: api_root https://api.telegram.org
```

Then:

1. Open the bot in Telegram.
2. Send `/start`.
3. Send a normal message.

## Configuration

- `TELEGRAM_BOT_TOKEN`: bot token from BotFather
- `ALLOWED_TELEGRAM_USER_IDS`: comma-separated Telegram user IDs allowed to control the bot
- `CODEX_WORKDIR`: working directory used for Codex tasks
- `CODEX_FULL_AUTO`: when `1`, adds `--full-auto`
- `CODEX_SANDBOX`: sandbox mode passed to `codex exec -s`
- `CODEX_BIN`: optional, defaults to `codex`
- `CODEX_MODEL`: optional, choose a specific model
- `CODEX_PROFILE`: optional, choose a Codex profile
- `CODEX_SKIP_GIT_REPO_CHECK`: optional, when `1`, adds `--skip-git-repo-check`
- `TELEGRAM_PROXY_URL`: optional proxy URL for Telegram API access
- `TELEGRAM_API_ROOT`: optional, defaults to `https://api.telegram.org`
- `TELEGRAM_FILE_ROOT`: optional, defaults to `${TELEGRAM_API_ROOT}/file`
- `TELEGRAM_CODEX_STATE_DIR`: optional, defaults to `~/.codex-telegram-bridge`
- `MAX_PROMPT_CHARS`: prompt size cap, default `16000`
- `MAX_OUTPUT_CHARS`: Telegram reply size cap, default `12000`

If `TELEGRAM_PROXY_URL` is unset, the bridge will also try `HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY`.

## Run As A Service

`systemd` is the recommended deployment option on a normal Linux host.

1. Copy the template:

```bash
sudo cp deploy/systemd/telegram-codex-bridge.service.example /etc/systemd/system/telegram-codex-bridge.service
```

2. Edit these fields:

- `User`
- `WorkingDirectory`
- `EnvironmentFile`
- `ExecStart`

3. Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-codex-bridge
sudo systemctl status telegram-codex-bridge
```

4. Follow logs:

```bash
journalctl -u telegram-codex-bridge -f
```

The template lives at [deploy/systemd/telegram-codex-bridge.service.example](deploy/systemd/telegram-codex-bridge.service.example).

## Troubleshooting

### `ALLOWED_TELEGRAM_USER_IDS is required`

Your `.env` is missing the allowlist entry.

### `409 Conflict`

Another long-polling bot instance is already using the same token. Stop the other instance or rotate the token in `@BotFather`.

### Telegram API timeout

Your host cannot reach Telegram directly. Check your proxy and set `TELEGRAM_PROXY_URL`.

### The bot does not reply

- Confirm you are messaging the correct bot
- Confirm your Telegram account is allowlisted
- Check bridge logs
- Confirm `codex` works locally in the same environment

## Security

This project exposes a Telegram bot as a remote control surface for Codex CLI.

- Do not commit `.env`
- Allowlist trusted Telegram accounts only
- Rotate leaked bot tokens immediately
- Be careful with `CODEX_FULL_AUTO=1` on sensitive machines

See [SECURITY.md](SECURITY.md) for the short security notes.

## Release Checklist

1. Make sure `.env` is not committed.
2. Revoke any exposed bot token before publishing.
3. Replace private absolute paths in examples if needed.
4. Run `npm run check`.

## License

MIT. See [LICENSE](LICENSE).
