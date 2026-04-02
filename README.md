# Telegram / Feishu Codex Bridge

[中文说明](README_zh.md)

One repo, one root `.env`, one `npm start`.

This repo has more than one control path.

The shared core is a reusable Codex runtime, with multiple parallel entry modes on top:

- `Telegram mode`: a Telegram bot directly controls local Codex
- `Feishu mode`: a Feishu / Lark bot directly controls local Codex
- `Remote mode`: `remote-client` controls `remote-server`, and the local agent runs Codex

Telegram / Feishu / Remote are parallel modes, not one chained pipeline.

## Recent Changes

- Added Feishu/Lark support with persistent connection and webhook modes
- Unified root entrypoint with `BRIDGE_PLATFORM=telegram|feishu`
- Added shared Codex runtime core for Telegram and Feishu adapters
- Improved rich-text rendering for Telegram and Feishu replies

## Choose A Mode

### Mode 1: Telegram

Use this when:

- you want to talk to Codex directly from Telegram

Start it with:

```bash
npm install
cp .env.example .env
npm start
```

Root `.env`:

```dotenv
BRIDGE_PLATFORM=telegram
```

### Mode 2: Feishu / Lark

Use this when:

- you want to talk to Codex directly from Feishu / Lark

Start it with:

```bash
npm install
cp .env.example .env
npm start
```

Root `.env`:

```dotenv
BRIDGE_PLATFORM=feishu
```

If you omit `BRIDGE_PLATFORM`, the bridge auto-detects:

- `feishu` when `FEISHU_APP_ID` is set and `TELEGRAM_BOT_TOKEN` is unset
- otherwise `telegram`

### Mode 3: Remote

Use this when:

- you do not want to expose the local Codex machine publicly
- you want a separate public `remote-client`
- you want to control local Codex remotely

Start it with:

```bash
npm run start:remote-client
npm run start:remote-server
```

Detailed setup:

- [docs/remote-mode.md](docs/remote-mode.md)

## Feishu / Lark

If this is your first Feishu setup, use this shortest path:

1. Open <https://open.feishu.cn/>
2. Create a self-built app
3. Enable bot capability
4. Add messaging permissions
5. In `Events and Callbacks`, choose `Receive events through persistent connection`
6. Subscribe to `im.message.receive_v1`
7. Publish the app
8. Configure the root `.env`
9. Run `npm start`
10. Set `FEISHU_ALLOW_FROM=ou_xxx` first; after you DM the bot, it will reply with your real `open_id`

Minimum required steps:

- Create the app
- Enable bot capability
- Subscribe to `im.message.receive_v1`
- Publish the app
- Fill `.env`

Example:

```dotenv
BRIDGE_PLATFORM=feishu
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
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
- Group chat enabled by default once the bot is added
- Optional group allowlist and optional `@mention` gating
- Group chats use separate Codex sessions per sender
- Per-sender `workdir` overrides are supported
- Approximate streaming updates from Codex JSON events
- `/start`, `/status`, `/reset`

If you enable `FEISHU_REQUIRE_MENTION=1`:

- You can set `FEISHU_BOT_OPEN_ID` manually
- Or leave it unset and let the bridge auto-learn it from the first clear group `@bot` event

If you want different senders to land in different project directories, set:

```dotenv
FEISHU_USER_WORKDIR_MAP=ou_alice=/work/project-a;ou_bob=/work/project-b
```

Notes:

- key = sender `open_id`
- value = the effective `CODEX_WORKDIR` for that sender
- senders not listed still use the global `CODEX_WORKDIR`

Detailed Feishu setup remains in [adapters/feishu/README.md](adapters/feishu/README.md), but you no longer need to start from that subdirectory. Root `npm start` will hand off to the Feishu adapter when `BRIDGE_PLATFORM=feishu`.

## Telegram

Example:

```dotenv
BRIDGE_PLATFORM=telegram
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
```

Features:

- Telegram private chat bot
- Photo/document download support
- `/start`, `/status`, `/reset`

Shortest config:

```dotenv
BRIDGE_PLATFORM=telegram
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
```

## Shared Configuration

- `CODEX_WORKDIR`
- `CODEX_BIN`
- `CODEX_APPROVAL_MODE`
- `CODEX_SANDBOX_MODE`
- `CODEX_BYPASS_APPROVALS_AND_SANDBOX`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `CODEX_SKIP_GIT_REPO_CHECK`
- `MAX_PROMPT_CHARS`
- `MAX_OUTPUT_CHARS`
- `BRIDGE_STATE_DIR`

## Remote Mode

Remote mode does not depend on Telegram or Feishu.

It is a separate parallel control path:

- `remote-client`: public hub
- `remote-server`: local agent

Shortest setup:

### `remote-client`

```dotenv
REMOTE_CLIENT_HOST=0.0.0.0
REMOTE_CLIENT_PORT=8789
REMOTE_SHARED_SECRET=replace_me
REMOTE_CLIENT_API_TOKEN=replace_me
```

```bash
npm run start:remote-client
```

### `remote-server`

```dotenv
REMOTE_CLIENT_URL=https://your-client.example.com
REMOTE_SERVER_ID=my-laptop
REMOTE_SHARED_SECRET=replace_me
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

```bash
npm run start:remote-server
```

### Remote API

List connected servers:

```bash
curl -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  http://127.0.0.1:8789/remote/api/servers
```

Run a prompt on a remote server:

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/run \
  -d '{
    "server_id": "my-laptop",
    "chat_key": "demo-chat",
    "text": "Inspect the current repository structure"
  }'
```

Get status:

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/status \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

Reset a session:

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/reset \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

Notes:

- `chat_key` controls remote session reuse
- requests for the same `chat_key` are serialized
- `remote-client` is currently a generic HTTP hub
- remote mode is parallel to Telegram / Feishu, not wired through them

Detailed setup:

- [docs/remote-mode.md](docs/remote-mode.md)

## Execution Modes

These two variables control how the bridge invokes `codex exec`:

- `CODEX_APPROVAL_MODE` maps to `codex exec -a`
- `CODEX_SANDBOX_MODE` maps to `codex exec -s`
- `CODEX_BYPASS_APPROVALS_AND_SANDBOX=1` maps to `codex --dangerously-bypass-approvals-and-sandbox exec ...`

Recommended default:

```dotenv
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

This is the safer mode:

- Codex can still ask for approval before higher-risk actions
- File access stays inside the normal workspace-write sandbox
- Recommended for most public or shared deployments

Unattended full-auto mode:

```dotenv
CODEX_APPROVAL_MODE=never
CODEX_SANDBOX_MODE=danger-full-access
```

Use this only if you explicitly want the bridge to run Codex without interactive approval:

- `CODEX_APPROVAL_MODE=never` means Codex will not stop to ask for confirmation
- `CODEX_SANDBOX_MODE=danger-full-access` gives Codex broad host access
- This is convenient for automation, but it is the highest-risk setup in this repo
- Do not enable it on a machine you do not fully trust with remote bot-triggered actions

Fully bypass Codex approvals and sandbox:

```dotenv
CODEX_BYPASS_APPROVALS_AND_SANDBOX=1
```

When this is enabled, the bridge sends:

```bash
codex --dangerously-bypass-approvals-and-sandbox exec ...
```

Notes:

- This is more dangerous than `CODEX_APPROVAL_MODE=never` plus `CODEX_SANDBOX_MODE=danger-full-access`
- When enabled, it takes precedence over `CODEX_APPROVAL_MODE` and `CODEX_SANDBOX_MODE`
- Use it only if the machine is already externally sandboxed or you intentionally want zero Codex-side protections

Compatibility:

- `CODEX_FULL_AUTO=1` maps to `CODEX_APPROVAL_MODE=never`
- `CODEX_FULL_AUTO=0` maps to `CODEX_APPROVAL_MODE=on-request`
- `CODEX_SANDBOX` is still accepted as a legacy alias for `CODEX_SANDBOX_MODE`

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
