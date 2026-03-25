# 飞书新手快速接入

这份文档只讲一件事：第一次把这个仓库接到飞书，并且尽量少踩坑。

目标效果：

- 你在飞书里创建一个机器人
- 把它拉进私聊或群聊
- 在本机运行这个仓库
- 直接在飞书里给 Codex 发消息

## 1. 先准备好这几样

- 一台能运行 `node` 和 `codex` 的机器
- 一个飞书企业账号
- 飞书开放平台可创建“企业自建应用”的权限

先确认本机命令正常：

```bash
node -v
codex --version
```

## 2. 在飞书开放平台创建应用

1. 打开 <https://open.feishu.cn/>
2. 进入开发者后台
3. 创建“企业自建应用”
4. 给应用起个名字，比如 `Codex Bridge`
5. 开启“机器人能力”

创建后先记下两个值：

- `App ID`
- `App Secret`

后面会填到 `.env`：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
```

## 3. 给应用加权限

先用这一组，比较省事：

租户权限：

- `im:chat.access_event.bot_p2p_chat:read`
- `im:chat.members:bot_access`
- `im:message`
- `im:message.group_at_msg:readonly`
- `im:message.p2p_msg:readonly`
- `im:message:readonly`
- `im:message:send_as_bot`

如果控制台支持批量导入，用这个：

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
      "im:message:send_as_bot"
    ]
  }
}
```

## 4. 配事件订阅

你这套仓库默认推荐用左边那个长连接模式，不需要公网。

在飞书后台找到：

- `Events and Callbacks`
- `Subscription mode`

选择：

- `Receive events through persistent connection`

然后订阅事件：

- `im.message.receive_v1`

这套模式下：

- 不需要公网 URL
- 不需要 `Verification Token`
- 不需要 `Encrypt Key`

## 5. 发布应用

这一步别漏：

1. 创建版本
2. 提交发布
3. 等审批通过

没发布的话，机器人通常不会正常工作。

## 6. 在仓库根目录配置 `.env`

先复制示例文件：

```bash
cp .env.example .env
```

推荐先用这份最小配置：

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

说明：

- `BRIDGE_PLATFORM=feishu`：走飞书入口
- `CODEX_WORKDIR`：Codex 实际工作的仓库目录
- `CODEX_BIN`：`codex` 命令的绝对路径
- `FEISHU_ALLOW_FROM`：先随便写一个占位值就行，后面机器人会把你的真实 `open_id` 回给你
- `FEISHU_SUBSCRIPTION_MODE=websocket`：对应飞书后台左边的长连接模式

## 7. `FEISHU_ALLOW_FROM` 怎么拿

这里不用先自己查。

直接按下面做：

1. 先在 `.env` 里随便写一个假的值，比如：

```dotenv
FEISHU_ALLOW_FROM=ou_xxx
```

2. 启动 bridge
3. 私聊机器人，随便发一句话
4. 因为你还不在 allowlist 里，机器人会直接回你：

```text
This bot is not allowlisted.
Your open_id is: ou_xxxxxxxxxxxxx
```

5. 把这个值填回 `.env`：

```dotenv
FEISHU_ALLOW_FROM=ou_xxxxxxxxxxxxx
```

6. 重启服务

也就是说，这里可以直接“胡写”，因为机器人会把你真正要填的 `open_id` 告诉你。

## 8. 启动

在仓库根目录运行：

```bash
npm install
npm start
```

正常启动后你会看到类似：

```text
codex-feishu-bridge: started
codex-feishu-bridge: subscription_mode websocket
codex-feishu-bridge: domain feishu
```

## 9. 怎么测试

### 私聊测试

1. 在飞书里打开机器人
2. 发 `/start`
3. 再发一句普通文本

### 群聊测试

当前这套默认就是：

- 机器人拉进群后，群里所有人都可以直接触发
- 默认不要求 `@机器人`

如果你想先测群聊：

1. 把机器人拉进群
2. 直接在群里发一句话

## 10. 最常见的坑

### 机器人没反应

通常是这几个原因：

- 应用还没发布
- 事件 `im.message.receive_v1` 没订阅
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 填错
- 机器人能力没开
- 飞书消息发送权限没开

如果你已经能在日志里看到收到事件，但飞书里没回消息，优先检查：

- 应用是否已经发布到当前租户
- 机器人能力是否已开启
- 是否有 `im:message:send_as_bot`
- 是否有消息读取权限

只有在“机器人能正常回消息”这个前提下，`FEISHU_ALLOW_FROM=ou_xxx` 这种占位写法才会把你的真实 `open_id` 回显出来

### 终端报 `spawn codex ENOENT`

说明找不到 `codex` 命令。把 `.env` 里的 `CODEX_BIN` 改成绝对路径。

先查：

```bash
which codex
```

然后填：

```dotenv
CODEX_BIN=/your/real/path/to/codex
```

### 终端报 `unexpected argument '-a'`

这是旧版本 `codex` 参数顺序兼容问题。仓库现在已经修过了；如果你还看到这个错误，先确认你已经拉到最新代码并重启进程。

## 11. 推荐默认值

对大多数人，先用这组：

```dotenv
CODEX_APPROVAL_MODE=on-request
CODEX_SANDBOX_MODE=workspace-write
```

这表示：

- Codex 仍然可以在高风险动作前请求确认
- 运行在正常沙箱里

如果你明确要无人值守自动执行，才改成：

```dotenv
CODEX_APPROVAL_MODE=never
CODEX_SANDBOX_MODE=danger-full-access
```

这会更方便，但风险也更高。

## 12. 如果你只想最快跑通

最短路径就是：

1. 创建飞书自建应用
2. 开机器人能力
3. 加消息权限
4. 选左边 `persistent connection`
5. 订阅 `im.message.receive_v1`
6. 发布应用
7. 配好根目录 `.env`
8. `npm start`
9. 私聊机器人拿到自己的 `open_id`
10. 改好 `FEISHU_ALLOW_FROM`
11. 重启

## 13. 进一步文档

- 主说明：[README_zh.md](../README_zh.md)
- 飞书详细说明：[adapters/feishu/README.md](../adapters/feishu/README.md)
