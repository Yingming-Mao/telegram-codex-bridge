# Telegram Codex Bridge

[English](README.md)

这是一个把 Telegram 私聊消息桥接到 Codex CLI 的机器人服务。

Codex CLI 目前没有原生的 Telegram 入站通道，所以这个项目采用独立 bridge 的方式：接收 Telegram 私聊消息，把每个聊天映射到各自的 Codex 会话线程，再把 Codex 的最终回复发回 Telegram。

## 消息流

```text
Telegram 用户
    |
    v
Telegram Bot API
    |
    v
telegram-codex-bridge
    |- 校验 ALLOWED_TELEGRAM_USER_IDS
    |- 把附件保存到本地 inbox
    |- 读取和保存每个聊天的状态
    |
    v
codex exec / codex exec resume
    |
    v
Codex 最终回复
    |
    v
telegram-codex-bridge
    |
    v
Telegram Bot API
    |
    v
Telegram 用户
```

## 功能

- 通过 Telegram 私聊控制 Codex
- 用 `ALLOWED_TELEGRAM_USER_IDS` 做白名单限制
- 多轮对话复用同一条 Codex session
- 照片会先保存到本地再传给 Codex
- 文档会先保存到本地，再把路径写进提示词
- 内置 `/start`、`/status`、`/reset`
- 支持 Telegram API 代理

## 限制

- 这不是挂到你当前已经打开的 Codex TUI 对话上
- 每条 Telegram 消息仍然会触发一次 CLI 调用
- 当前只支持私聊，不支持群组
- 是否能真正执行任务，还取决于本机 Codex 登录状态、沙箱和权限配置

## 环境要求

- Node.js 20+
- 本机可直接运行 `codex`
- 一个由 `@BotFather` 创建的 Telegram bot token
- 你自己的 Telegram 用户 ID

## 快速开始

```bash
cd /path/to/telegram-codex-bridge
npm install
cp .env.example .env
```

编辑 `.env`：

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace_me
ALLOWED_TELEGRAM_USER_IDS=123456789
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
# TELEGRAM_PROXY_URL=http://127.0.0.1:7890
```

启动：

```bash
npm start
```

正常启动后一般会看到：

```text
telegram-codex-bridge: polling as @your_bot_name
telegram-codex-bridge: workdir /abs/path/to/your/project
telegram-codex-bridge: api_root https://api.telegram.org
```

然后：

1. 在 Telegram 里打开你的 bot
2. 发送 `/start`
3. 再发一条普通消息测试

## 配置项

- `TELEGRAM_BOT_TOKEN`: BotFather 提供的 token
- `ALLOWED_TELEGRAM_USER_IDS`: 允许访问 bot 的 Telegram 用户 ID，逗号分隔
- `CODEX_WORKDIR`: Codex 执行任务时使用的工作目录
- `CODEX_FULL_AUTO`: `1` 时附带 `--full-auto`
- `CODEX_SANDBOX`: 传给 `codex exec -s` 的沙箱模式
- `CODEX_BIN`: 可选，默认 `codex`
- `CODEX_MODEL`: 可选，指定模型
- `CODEX_PROFILE`: 可选，指定 Codex profile
- `CODEX_SKIP_GIT_REPO_CHECK`: 可选，设为 `1` 时附带 `--skip-git-repo-check`
- `TELEGRAM_PROXY_URL`: 可选，Telegram API 走代理时使用
- `TELEGRAM_API_ROOT`: 可选，默认 `https://api.telegram.org`
- `TELEGRAM_FILE_ROOT`: 可选，默认 `${TELEGRAM_API_ROOT}/file`
- `TELEGRAM_CODEX_STATE_DIR`: 可选，默认 `~/.codex-telegram-bridge`
- `MAX_PROMPT_CHARS`: 传给 Codex 的提示词长度上限，默认 `16000`
- `MAX_OUTPUT_CHARS`: Telegram 回发消息长度上限，默认 `12000`

如果没有显式设置 `TELEGRAM_PROXY_URL`，程序也会自动尝试读取 `HTTPS_PROXY`、`HTTP_PROXY` 和 `ALL_PROXY`。

## 常驻运行

在正常 Linux 主机上，推荐用 `systemd`。

1. 复制模板：

```bash
sudo cp deploy/systemd/telegram-codex-bridge.service.example /etc/systemd/system/telegram-codex-bridge.service
```

2. 至少修改这些字段：

- `User`
- `WorkingDirectory`
- `EnvironmentFile`
- `ExecStart`

3. 重新加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-codex-bridge
sudo systemctl status telegram-codex-bridge
```

4. 查看日志：

```bash
journalctl -u telegram-codex-bridge -f
```

模板文件见 [deploy/systemd/telegram-codex-bridge.service.example](deploy/systemd/telegram-codex-bridge.service.example)。

## 常见问题

### 启动时报 `ALLOWED_TELEGRAM_USER_IDS is required`

说明 `.env` 里缺少白名单配置。

### 启动时报 `409 Conflict`

说明同一个 bot token 已经被另一个 long-polling 实例占用了。停掉另一个实例，或者去 `@BotFather` 重发 token。

### 启动时报 Telegram 超时

说明当前机器不能直接访问 Telegram API。检查代理，并设置 `TELEGRAM_PROXY_URL`。

### 发消息后 bot 不回复

- 确认你聊的是正确的 bot
- 确认你的 Telegram 账号在白名单里
- 查看 bridge 日志
- 确认当前环境下 `codex` 命令本身可用

## 安全

这个项目本质上是给 Telegram 打开了一个远程控制本机 Codex 的入口。

- 不要提交 `.env`
- 白名单只放可信账号
- token 泄漏后立刻撤销重发
- 对敏感机器慎用 `CODEX_FULL_AUTO=1`

补充说明见 [SECURITY.md](SECURITY.md)。

## 开源发布前检查

1. 确认 `.env` 没有提交进仓库。
2. 如果 token 曾经暴露过，先去 `@BotFather` 撤销。
3. 检查 README 和截图里是否还有私人绝对路径。
4. 执行 `npm run check`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
