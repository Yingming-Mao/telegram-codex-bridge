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

如果你是第一次配飞书，先按这个最短流程走：

1. 打开飞书开放平台 <https://open.feishu.cn/>
2. 创建“企业自建应用”
3. 开启“机器人能力”
4. 配消息相关权限
5. 在 `Events and Callbacks` 里选择左边 `Receive events through persistent connection`
6. 订阅事件 `im.message.receive_v1`
7. 发布应用
8. 在仓库根目录配置 `.env`
9. 运行 `npm start`
10. 先把 `FEISHU_ALLOW_FROM=ou_xxx` 随便写上，私聊机器人后，它会把你的真实 `open_id` 回给你

最小必做项：

- 创建飞书应用
- 开机器人能力
- 订阅 `im.message.receive_v1`
- 发布应用
- 填 `.env`

示例：

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
- 默认拉进群就能用
- 也支持按群收紧和可选 `@mention` 触发
- 群聊里默认按“群 + 发言人”各自复用 session
- 支持按发言人覆盖 `workdir`
- 基于 Codex JSON 事件流的近似 streaming
- `/start`、`/status`、`/reset`

如果你把 `FEISHU_REQUIRE_MENTION=1` 打开了：

- 可以手动配置 `FEISHU_BOT_OPEN_ID`
- 也可以不填，bridge 会在第一次明确的群 `@机器人` 事件里自动记住它

如果你想让不同发言人默认进不同项目目录，可以配置：

```dotenv
FEISHU_USER_WORKDIR_MAP=ou_alice=/work/project-a;ou_bob=/work/project-b
```

说明：

- key 是发言人的 `open_id`
- value 是这个人对应的 `CODEX_WORKDIR`
- 没配到的人仍然走全局 `CODEX_WORKDIR`

更详细的飞书接入说明还在 [adapters/feishu/README.md](adapters/feishu/README.md)，但现在你已经不需要去那个子目录启动了。只要根目录 `BRIDGE_PLATFORM=feishu`，`npm start` 会自动切到飞书 adapter。

如果你是第一次配飞书，先看这份更短的入门文档：

- [docs/feishu-quickstart.zh.md](docs/feishu-quickstart.zh.md)

## Telegram

示例：

```dotenv
BRIDGE_PLATFORM=telegram
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_BIN=/abs/path/to/your/codex
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
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
- `CODEX_APPROVAL_MODE`
- `CODEX_SANDBOX_MODE`
- `CODEX_BYPASS_APPROVALS_AND_SANDBOX`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `CODEX_SKIP_GIT_REPO_CHECK`
- `MAX_PROMPT_CHARS`
- `MAX_OUTPUT_CHARS`
- `BRIDGE_STATE_DIR`

## 执行模式

这两个变量决定 bridge 调用 `codex exec` 时怎么传参：

- `CODEX_APPROVAL_MODE` 对应 `codex exec -a`
- `CODEX_SANDBOX_MODE` 对应 `codex exec -s`
- `CODEX_BYPASS_APPROVALS_AND_SANDBOX=1` 对应 `codex --dangerously-bypass-approvals-and-sandbox exec ...`

推荐默认值：

```dotenv
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

这是更安全的模式：

- Codex 在高风险动作前仍然可以请求审批
- 文件访问仍然限制在常规的 workspace-write 沙箱里
- 大多数公开部署或多人共用环境都建议用这一档

无人值守全自动模式：

```dotenv
CODEX_APPROVAL_MODE=never
CODEX_SANDBOX_MODE=danger-full-access
```

只有你明确希望 bridge 完全不弹审批、直接执行时，才应该启用：

- `CODEX_APPROVAL_MODE=never` 表示 Codex 不再停下来请求确认
- `CODEX_SANDBOX_MODE=danger-full-access` 表示给 Codex 更广的主机访问权限
- 这对自动化很方便，但也是这个仓库里风险最高的一档配置
- 不要在你不愿意让远程 bot 指令直接操作的机器上启用它

完全绕过 Codex 审批和沙箱：

```dotenv
CODEX_BYPASS_APPROVALS_AND_SANDBOX=1
```

开启后，bridge 会直接传：

```bash
codex --dangerously-bypass-approvals-and-sandbox exec ...
```

说明：

- 这比 `CODEX_APPROVAL_MODE=never` 加 `CODEX_SANDBOX_MODE=danger-full-access` 还更危险
- 开启后，它会覆盖 `CODEX_APPROVAL_MODE` 和 `CODEX_SANDBOX_MODE`
- 只建议在你明确知道自己在做什么，或者机器本身已经被外层环境隔离时使用

兼容说明：

- `CODEX_FULL_AUTO=1` 会映射成 `CODEX_APPROVAL_MODE=never`
- `CODEX_FULL_AUTO=0` 会映射成 `CODEX_APPROVAL_MODE=on-request`
- `CODEX_SANDBOX` 仍然可用，但现在是 `CODEX_SANDBOX_MODE` 的旧别名

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
