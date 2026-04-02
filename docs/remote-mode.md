# Remote Mode Quickstart

Remote mode is for this setup:

- you want to run `codex` on your local machine
- you do not want to expose that machine to the public internet
- you are willing to run a separate public `remote-client`

## Architecture

- `remote-client`: public hub with an HTTP API
- `remote-server`: local agent that connects outbound to `remote-client`

The control flow is:

1. you call `remote-client`
2. `remote-client` forwards the command over the control stream
3. `remote-server` runs `codex` locally
4. the result is sent back to `remote-client`

## 1. Start `remote-client`

On the public machine:

```dotenv
REMOTE_CLIENT_HOST=0.0.0.0
REMOTE_CLIENT_PORT=8789
REMOTE_SHARED_SECRET=replace_me
REMOTE_CLIENT_API_TOKEN=replace_me
```

Start it:

```bash
npm install
npm run start:remote-client
```

## 2. Start `remote-server`

On the local Codex machine:

```dotenv
REMOTE_CLIENT_URL=https://your-client.example.com
REMOTE_SERVER_ID=my-laptop
REMOTE_SHARED_SECRET=replace_me

CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

Start it:

```bash
npm install
npm run start:remote-server
```

Notes:

- `REMOTE_CLIENT_URL` points to the public `remote-client`
- `REMOTE_SHARED_SECRET` must match on both sides
- `REMOTE_SERVER_ID` identifies one local machine

## 3. Verify the connection

```bash
curl -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  http://127.0.0.1:8789/remote/api/servers
```

If the connection is healthy, you will see the online `server_id` list.

## 4. Run Codex remotely

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

Field meanings:

- `server_id`: target local machine
- `chat_key`: session key used for reuse
- `text`: the user message sent to Codex

## 5. Status and reset

Get status:

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/status \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

Reset the session:

```bash
curl -X POST \
  -H "Authorization: Bearer $REMOTE_CLIENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8789/remote/api/reset \
  -d '{"server_id":"my-laptop","chat_key":"demo-chat"}'
```

## Notes

- requests for the same `chat_key` are serialized
- session/thread state stays on `remote-server`
- `remote-server` does not need any public inbound port
- remote mode is a generic API mode and does not depend on Telegram or Feishu
