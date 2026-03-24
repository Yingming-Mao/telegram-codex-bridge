# Codex Feishu Bridge

独立的 Feishu / Lark -> Codex CLI bridge，目标是尽量接近 OpenClaw 的飞书接入体验，但保留一个更轻的实现。

这个子项目不依赖仓库根目录的 Telegram bridge，可以单独拆出来用。

## 适合谁用

如果你希望：

- 在飞书里直接和 Codex 对话
- 不想暴露公网 webhook
- 本地开发机也能接消息
- 想保留每个聊天各自复用一条 Codex session

那就用这个子项目。

## 当前能力

- 支持 Feishu 和 Lark 两个域
- 支持两种订阅模式：
  - `websocket`
  - `webhook`
- 支持文本消息
- 支持 `/start`、`/status`、`/reset`
- 支持私聊 allowlist
- 支持群策略和 `@mention`
- 支持基于 Codex JSON 事件流的近似 streaming

## 当前限制

- 还没接图片/文件消息
- 还没做 webhook 加密解密
- 还没做 streaming card
- 还没做 pairing

## 最重要的选择

飞书后台的 `Subscription mode` 有两个选项：

1. `Receive events through persistent connection`
2. `Send notifications to developer's server`

如果你没有公网服务器，或者只是本地调试：

- 选 `Receive events through persistent connection`
- 对应配置：`FEISHU_SUBSCRIPTION_MODE=websocket`

如果你已经有公网可访问的回调地址：

- 选 `Send notifications to developer's server`
- 对应配置：`FEISHU_SUBSCRIPTION_MODE=webhook`

对大多数本地开发场景，推荐第一种，也就是左边那个 `persistent connection`。这是我们前面聊天里最终确认的路径。

## 环境要求

- Node.js 20+
- 本机可直接运行 `codex`
- 一个飞书或 Lark 自建应用
- 应用已开启机器人能力
- 应用已配置事件订阅 `im.message.receive_v1`

## 目录

- [server.mjs](server.mjs)
- [package.json](package.json)
- [.env.example](.env.example)

## 1. 创建飞书应用

1. 打开飞书开放平台：<https://open.feishu.cn/>
2. 创建“企业自建应用”
3. 开启“机器人能力”
4. 记下：
   - `App ID`
   - `App Secret`

对应配置：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
```

## 2. 配权限

如果你想先稳妥一点，建议直接配这一组消息相关权限。

租户权限：

- `im:chat.access_event.bot_p2p_chat:read`
- `im:chat.members:bot_access`
- `im:message`
- `im:message.group_at_msg:readonly`
- `im:message.p2p_msg:readonly`
- `im:message:readonly`
- `im:message:send_as_bot`
- `im:resource`

用户权限：

- `im:chat.access_event.bot_p2p_chat:read`

如果控制台支持批量导入，可以直接用：

```json
{
  "scopes": {
    "tenant": [
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": [
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}
```

如果你只是先做私聊文本，理论上最小权限可以更少，但为了少踩坑，建议先按上面这一组配。

## 3. 配事件订阅

事件订阅至少加：

- `im.message.receive_v1`

### 如果你选左边 persistent connection

飞书后台选择：

- `Receive events through persistent connection`

这时：

- 不需要公网 URL
- 不需要配置 `Verification Token`
- 不需要配置 `Encrypt Key`

对应 `.env`：

```dotenv
FEISHU_SUBSCRIPTION_MODE=websocket
```

### 如果你选右边 webhook

飞书后台选择：

- `Send notifications to developer's server`

这时你需要：

- Request URL
- `Verification Token`

并且当前版本要求：

- 不开启 `Encrypt Key`

对应 `.env`：

```dotenv
FEISHU_SUBSCRIPTION_MODE=webhook
FEISHU_VERIFICATION_TOKEN=replace_me
```

## 4. 发布应用

这个步骤很容易漏。

你需要在飞书后台：

1. 创建版本
2. 提交发布
3. 等审批/发布完成

如果应用没发布，机器人经常表现为：

- 看起来已经配好了
- 但飞书客户端里搜不到或不生效

## 5. 配本地 `.env`

先复制：

```bash
cd adapters/feishu
cp .env.example .env
```

### 推荐配置：左边 persistent connection

这是最推荐的版本，适合没公网服务器的情况：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
FEISHU_ALLOW_FROM=ou_xxx
FEISHU_SUBSCRIPTION_MODE=websocket
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
```

说明：

- `FEISHU_ALLOW_FROM` 必填
- `FEISHU_VERIFICATION_TOKEN` 这里不需要

### 如果你走 webhook

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
FEISHU_ALLOW_FROM=ou_xxx
FEISHU_VERIFICATION_TOKEN=replace_me
FEISHU_SUBSCRIPTION_MODE=webhook
FEISHU_WEBHOOK_HOST=127.0.0.1
FEISHU_WEBHOOK_PORT=3000
FEISHU_WEBHOOK_PATH=/feishu/events
CODEX_WORKDIR=/abs/path/to/your/project
CODEX_FULL_AUTO=1
CODEX_SANDBOX=workspace-write
```

## 6. `FEISHU_ALLOW_FROM` 怎么写

这个字段写的是允许使用机器人的飞书用户 `open_id`。

单个人：

```dotenv
FEISHU_ALLOW_FROM=ou_1234567890abcdef
```

多个人：

```dotenv
FEISHU_ALLOW_FROM=ou_aaa,ou_bbb,ou_ccc
```

注意：

- 这里不是手机号
- 不是邮箱
- 不是 `user_id`
- 是 `open_id`

## 7. `FEISHU_VERIFICATION_TOKEN` 什么时候需要

只有在 `webhook` 模式才需要。

如果你现在按推荐方案走左边 `persistent connection`：

- 可以不填

所以这两个字段的关系是：

- `FEISHU_ALLOW_FROM`：必须
- `FEISHU_VERIFICATION_TOKEN`：仅 webhook 需要

## 8. 启动

在子项目目录执行：

```bash
cd adapters/feishu
npm install
node server.mjs
```

正常启动日志应该类似：

```text
codex-feishu-bridge: started
codex-feishu-bridge: subscription_mode websocket
codex-feishu-bridge: domain feishu
codex-feishu-bridge: api_root https://open.feishu.cn/open-apis
codex-feishu-bridge: workdir /abs/path/to/your/project
```

如果你走 webhook，还会多一行：

```text
codex-feishu-bridge: webhook http://127.0.0.1:3000/feishu/events
```

## 9. 测试顺序

建议按这个顺序测：

1. 确认应用已经发布
2. 确认权限已经审批通过
3. 启动 bridge
4. 在飞书里打开机器人
5. 先发 `/start`
6. 再发普通文本

如果你开启了群聊支持，再测：

1. 把机器人拉进群
2. 在群里 `@机器人` 再发消息

## 10. 群聊配置

默认行为是保守的。

关键配置：

- `FEISHU_GROUP_POLICY=disabled`
- `FEISHU_GROUP_POLICY=open`
- `FEISHU_GROUP_POLICY=allowlist`

如果是 `allowlist`，还要配：

```dotenv
FEISHU_GROUP_ALLOW_FROM=oc_xxx,oc_yyy
```

默认群里还要求 `@mention`：

```dotenv
FEISHU_REQUIRE_MENTION=1
```

如果你想群里不用 `@` 也能触发：

```dotenv
FEISHU_REQUIRE_MENTION=0
```

## 11. Streaming 说明

这版做了“近似 OpenClaw 体验”的 streaming：

- 先发占位消息
- 随着 Codex JSON 事件流更新消息内容
- 如果飞书消息更新失败，就自动退化成普通续发

可调配置：

```dotenv
FEISHU_STREAMING=1
FEISHU_STREAM_UPDATE_MS=800
```

## 12. 常见问题

### 1. 为什么我应该选左边，而不是右边？

如果你没有公网服务器，右边 webhook 模式就需要飞书能访问到你的机器。  
左边 persistent connection 由你的程序主动连飞书，更适合本地开发和内网环境。

### 2. 我已经配好了，机器人还是不回

先按顺序检查：

- 应用是否已经发布
- 权限是否已经审批通过
- 是否订阅了 `im.message.receive_v1`
- `FEISHU_ALLOW_FROM` 里是否是正确的 `open_id`
- `node server.mjs` 是否正常启动
- `codex` 在本机是否能跑

### 3. 为什么 `FEISHU_VERIFICATION_TOKEN` 不需要？

因为你如果走的是左边 persistent connection，就没有 webhook 校验流程。

### 4. 我填的是手机号/邮箱，为什么没反应？

因为 allowlist 用的是 `open_id`，不是手机号、邮箱或普通用户 ID。

## 13. 自检

```bash
npm run check
```

## 14. 后续可做

如果你后面还想继续靠近 OpenClaw，可以继续补：

- 图片/文件消息
- webhook 加密
- 更完整的 streaming card
- 更细的 sender/room 路由策略
