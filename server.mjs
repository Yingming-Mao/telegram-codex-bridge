#!/usr/bin/env node

import {
  formatTelegramStartupError,
  redactUrlAuth,
  splitText,
} from './bridge-core.mjs';
import { renderTelegramHtml } from './bridge-rich-text.mjs';
import {
  createChatQueueManager,
  createChatStateStore,
  createCodexRuntime,
} from './codex-runtime.mjs';
import { Bot } from 'grammy';
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(__filename);
const FEISHU_ADAPTER_ROOT = join(PROJECT_ROOT, 'adapters', 'feishu');

loadEnvFile(join(PROJECT_ROOT, '.env'));

const BRIDGE_PLATFORM = detectBridgePlatform();

if (BRIDGE_PLATFORM === 'feishu') {
  await handoffToFeishuStandalone();
  process.exit(0);
}

const STATE_DIR =
  process.env.BRIDGE_STATE_DIR ??
  process.env.TELEGRAM_CODEX_STATE_DIR ??
  process.env.LARK_CODEX_STATE_DIR ??
  join(homedir(), BRIDGE_PLATFORM === 'lark' ? '.codex-lark-bridge' : '.codex-telegram-bridge');

loadEnvFile(join(STATE_DIR, '.env'));

const CHAT_DIR = join(STATE_DIR, 'chats');
const INBOX_DIR = join(STATE_DIR, 'inbox');
const RUN_DIR = join(STATE_DIR, 'runs');

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR ?? resolve(PROJECT_ROOT, '..');
const CODEX_MODEL = process.env.CODEX_MODEL;
const CODEX_PROFILE = process.env.CODEX_PROFILE;
const CODEX_BYPASS_APPROVALS_AND_SANDBOX = parseBool(
  process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX ?? '0',
);
const CODEX_APPROVAL_MODE = normalizeCodexApprovalMode(
  process.env.CODEX_APPROVAL_MODE,
  process.env.CODEX_FULL_AUTO,
);
const CODEX_SANDBOX_MODE = normalizeCodexSandboxMode(
  process.env.CODEX_SANDBOX_MODE,
  process.env.CODEX_SANDBOX,
);
const CODEX_SKIP_GIT_REPO_CHECK = parseBool(process.env.CODEX_SKIP_GIT_REPO_CHECK ?? '0');
const MAX_PROMPT_CHARS = positiveInt(process.env.MAX_PROMPT_CHARS, 16000);
const MAX_OUTPUT_CHARS = positiveInt(process.env.MAX_OUTPUT_CHARS, 12000);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_IDS = new Set(parseCsv(process.env.ALLOWED_TELEGRAM_USER_IDS));
const TELEGRAM_API_ROOT = stripTrailingSlash(process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org');
const TELEGRAM_PROXY_URL = firstEnvValue([
  'TELEGRAM_PROXY_URL',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
]);
const TELEGRAM_FILE_ROOT = stripTrailingSlash(
  process.env.TELEGRAM_FILE_ROOT ?? `${TELEGRAM_API_ROOT}/file`,
);
const TELEGRAM_CHUNK_LIMIT = 3800;
const TELEGRAM_FETCH_AGENT = buildTelegramFetchAgent(TELEGRAM_PROXY_URL);

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_ALLOWED_OPEN_IDS = new Set(parseCsv(process.env.ALLOWED_LARK_OPEN_IDS));
const LARK_API_ROOT = stripTrailingSlash(process.env.LARK_API_ROOT ?? 'https://open.feishu.cn/open-apis');
const LARK_HOST = process.env.LARK_HOST ?? '0.0.0.0';
const LARK_PORT = positiveInt(process.env.LARK_PORT, 8787);
const LARK_WEBHOOK_PATH = normalizeWebhookPath(process.env.LARK_WEBHOOK_PATH ?? '/webhook/lark');
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN?.trim() || null;
const LARK_ALLOW_GROUPS = parseBool(process.env.LARK_ALLOW_GROUPS ?? '0');
const LARK_CHUNK_LIMIT = 3000;

const seenLarkEvents = new Map();
let larkAccessTokenCache = null;
let bot = null;
let larkServer = null;
let shutdownRequested = false;
const stateStore = createChatStateStore(CHAT_DIR);
const queueManager = createChatQueueManager({ logPrefix: 'telegram-codex-bridge' });
const codexRuntime = createCodexRuntime({
  bin: CODEX_BIN,
  approvalMode: CODEX_APPROVAL_MODE,
  bypassApprovalsAndSandbox: CODEX_BYPASS_APPROVALS_AND_SANDBOX,
  model: CODEX_MODEL,
  profile: CODEX_PROFILE,
  runDir: RUN_DIR,
  sandboxMode: CODEX_SANDBOX_MODE,
  skipGitRepoCheck: CODEX_SKIP_GIT_REPO_CHECK,
  stateDir: STATE_DIR,
  workdir: CODEX_WORKDIR,
});

registerShutdownHandlers();

await Promise.all([
  mkdir(STATE_DIR, { recursive: true }),
  mkdir(CHAT_DIR, { recursive: true }),
  mkdir(INBOX_DIR, { recursive: true }),
  mkdir(RUN_DIR, { recursive: true }),
]);

if (BRIDGE_PLATFORM === 'lark') {
  validateLarkConfig();
  await startLarkBridge();
} else {
  validateTelegramConfig();
  await startTelegramBridge();
}

function detectBridgePlatform() {
  const explicit = process.env.BRIDGE_PLATFORM?.trim().toLowerCase();
  if (explicit === 'telegram' || explicit === 'lark' || explicit === 'feishu') {
    return explicit;
  }
  if ((process.env.FEISHU_APP_ID || process.env.LARK_APP_ID) && !process.env.TELEGRAM_BOT_TOKEN) {
    return 'feishu';
  }
  return 'telegram';
}

async function handoffToFeishuStandalone() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: FEISHU_ADAPTER_ROOT,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', code => {
      if ((code ?? 0) === 0) {
        resolve();
      } else {
        reject(new Error(`Feishu bridge exited with code ${code ?? 'unknown'}.`));
      }
    });
  });
}

function validateTelegramConfig() {
  if (!TELEGRAM_TOKEN) {
    process.stderr.write(
      'telegram-codex-bridge: TELEGRAM_BOT_TOKEN is required in telegram mode.\n' +
        `Put it in ${join(PROJECT_ROOT, '.env')} or ${join(STATE_DIR, '.env')}.\n`,
    );
    process.exit(1);
  }
  if (TELEGRAM_ALLOWED_USER_IDS.size === 0) {
    process.stderr.write(
      'telegram-codex-bridge: ALLOWED_TELEGRAM_USER_IDS is required for safety.\n',
    );
    process.exit(1);
  }
}

function validateLarkConfig() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    process.stderr.write(
      'telegram-codex-bridge: LARK_APP_ID and LARK_APP_SECRET are required in lark mode.\n' +
        `Put them in ${join(PROJECT_ROOT, '.env')} or ${join(STATE_DIR, '.env')}.\n`,
    );
    process.exit(1);
  }
  if (LARK_ALLOWED_OPEN_IDS.size === 0) {
    process.stderr.write(
      'telegram-codex-bridge: ALLOWED_LARK_OPEN_IDS is required for safety.\n',
    );
    process.exit(1);
  }
}

async function startTelegramBridge() {
  bot = new Bot(TELEGRAM_TOKEN, {
    client: {
      apiRoot: TELEGRAM_API_ROOT,
      baseFetchConfig: TELEGRAM_FETCH_AGENT ? { agent: TELEGRAM_FETCH_AGENT } : undefined,
    },
  });

  bot.command('start', async ctx => {
    if (ctx.chat?.type !== 'private') return;

    const allowed = isTelegramUserAllowed(ctx.from?.id);
    const text = allowed
      ? [
          'Telegram Codex bridge is online.',
          '',
          'Send a normal message to start a Codex session in this chat.',
          'Later messages resume the same Codex session.',
          'Commands:',
          '/status - show current chat status',
          '/reset - drop this chat session and start fresh',
        ].join('\n')
      : [
          'This bot is not allowlisted for your account.',
          '',
          `Your Telegram user ID is: ${ctx.from?.id ?? 'unknown'}`,
        ].join('\n');

    await ctx.reply(text);
  });

  bot.command('status', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    if (!isTelegramUserAllowed(ctx.from?.id)) {
      await ctx.reply(
        `This bot is not allowlisted.\nYour Telegram user ID is: ${ctx.from?.id ?? 'unknown'}`,
      );
      return;
    }

    const text = await renderStatusText(`telegram:${ctx.chat.id}`, {
      channelLabel: 'telegram',
      chatId: String(ctx.chat.id),
      userId: String(ctx.from?.id ?? 'unknown'),
    });
    await ctx.reply(text);
  });

  bot.command('reset', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    if (!isTelegramUserAllowed(ctx.from?.id)) return;

    await stateStore.reset(`telegram:${ctx.chat.id}`);
    await ctx.reply('Session cleared for this chat. The next message will start a fresh Codex session.');
  });

  bot.on('message:text', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    if (!isTelegramUserAllowed(ctx.from?.id)) return;
    if (ctx.message.text.startsWith('/')) return;

    const chatKey = `telegram:${ctx.chat.id}`;
    void queueManager.enqueue(
      chatKey,
      () => ctx.reply('Previous request is still running. Your message has been queued.'),
      async () => {
        await handleBridgeMessage({
          chatKey,
          payload: {
            text: ctx.message.text,
            attachments: [],
            imagePaths: [],
          },
          createPending: async resume =>
            await ctx.reply(
              resume ? 'Received. Resuming Codex session...' : 'Received. Starting Codex session...',
            ),
          startProgress: () => startTelegramTyping(String(ctx.chat.id)),
          sendResponse: async (pending, text) => {
            await sendTelegramResponse(ctx, pending?.message_id, text);
          },
        });
      },
    );
  });

  bot.on('message:photo', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    if (!isTelegramUserAllowed(ctx.from?.id)) return;

    const chatKey = `telegram:${ctx.chat.id}`;
    void queueManager.enqueue(
      chatKey,
      () => ctx.reply('Previous request is still running. Your message has been queued.'),
      async () => {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const imagePath = await downloadTelegramFile(photo.file_id, `${photo.file_unique_id}.jpg`);
        await handleBridgeMessage({
          chatKey,
          payload: {
            text: ctx.message.caption?.trim() || '(photo attached)',
            attachments: [{ kind: 'photo', path: imagePath, name: imagePath.split('/').pop() ?? 'photo' }],
            imagePaths: [imagePath],
          },
          createPending: async resume =>
            await ctx.reply(
              resume ? 'Received. Resuming Codex session...' : 'Received. Starting Codex session...',
            ),
          startProgress: () => startTelegramTyping(String(ctx.chat.id)),
          sendResponse: async (pending, text) => {
            await sendTelegramResponse(ctx, pending?.message_id, text);
          },
        });
      },
    );
  });

  bot.on('message:document', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    if (!isTelegramUserAllowed(ctx.from?.id)) return;

    const chatKey = `telegram:${ctx.chat.id}`;
    void queueManager.enqueue(
      chatKey,
      () => ctx.reply('Previous request is still running. Your message has been queued.'),
      async () => {
        const doc = ctx.message.document;
        const filePath = await downloadTelegramFile(
          doc.file_id,
          doc.file_name ?? `${doc.file_unique_id}.bin`,
        );
        const label = safeName(doc.file_name) ?? filePath.split('/').pop() ?? 'document';
        await handleBridgeMessage({
          chatKey,
          payload: {
            text: ctx.message.caption?.trim() || `(document: ${label})`,
            attachments: [{ kind: 'document', path: filePath, name: label }],
            imagePaths: isImagePath(filePath) ? [filePath] : [],
          },
          createPending: async resume =>
            await ctx.reply(
              resume ? 'Received. Resuming Codex session...' : 'Received. Starting Codex session...',
            ),
          startProgress: () => startTelegramTyping(String(ctx.chat.id)),
          sendResponse: async (pending, text) => {
            await sendTelegramResponse(ctx, pending?.message_id, text);
          },
        });
      },
    );
  });

  bot.catch(err => {
    process.stderr.write(
      `telegram-codex-bridge: handler error: ${err.error?.stack ?? err.error ?? err}\n`,
    );
  });

  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Show help' },
      { command: 'status', description: 'Show chat status' },
      { command: 'reset', description: 'Reset this chat session' },
    ]);

    await bot.start({
      onStart: info => {
        process.stderr.write(`telegram-codex-bridge: platform telegram\n`);
        process.stderr.write(`telegram-codex-bridge: polling as @${info.username}\n`);
        process.stderr.write(`telegram-codex-bridge: workdir ${CODEX_WORKDIR}\n`);
        process.stderr.write(`telegram-codex-bridge: state_dir ${STATE_DIR}\n`);
        process.stderr.write(`telegram-codex-bridge: api_root ${TELEGRAM_API_ROOT}\n`);
        if (TELEGRAM_PROXY_URL) {
          process.stderr.write(`telegram-codex-bridge: proxy ${redactUrlAuth(TELEGRAM_PROXY_URL)}\n`);
        }
      },
    });
  } catch (err) {
    process.stderr.write(
      `${formatTelegramStartupError({
        err,
        apiRoot: TELEGRAM_API_ROOT,
        proxyUrl: TELEGRAM_PROXY_URL,
      })}\n`,
    );
    process.exit(1);
  }
}

async function startLarkBridge() {
  larkServer = http.createServer((req, res) => {
    void handleLarkHttp(req, res).catch(err => {
      process.stderr.write(`telegram-codex-bridge: lark webhook error: ${err?.stack ?? err}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { code: 500, msg: 'internal error' });
      } else {
        res.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    larkServer.once('error', reject);
    larkServer.listen(LARK_PORT, LARK_HOST, () => {
      larkServer.off('error', reject);
      resolve();
    });
  });

  process.stderr.write(`telegram-codex-bridge: platform lark\n`);
  process.stderr.write(`telegram-codex-bridge: webhook http://${LARK_HOST}:${LARK_PORT}${LARK_WEBHOOK_PATH}\n`);
  process.stderr.write(`telegram-codex-bridge: workdir ${CODEX_WORKDIR}\n`);
  process.stderr.write(`telegram-codex-bridge: state_dir ${STATE_DIR}\n`);
  process.stderr.write(`telegram-codex-bridge: api_root ${LARK_API_ROOT}\n`);
}

async function handleLarkHttp(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { ok: true, platform: 'lark' });
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (req.method !== 'POST' || pathname !== LARK_WEBHOOK_PATH) {
    sendJson(res, 404, { code: 404, msg: 'not found' });
    return;
  }

  const body = await readJsonBody(req);

  if (body?.encrypt) {
    sendJson(res, 400, {
      code: 400,
      msg: 'encrypted callbacks are not supported; disable Encrypt Key for this webhook',
    });
    return;
  }

  const callbackToken = body?.header?.token ?? body?.token ?? null;
  if (LARK_VERIFICATION_TOKEN && callbackToken !== LARK_VERIFICATION_TOKEN) {
    sendJson(res, 403, { code: 403, msg: 'invalid verification token' });
    return;
  }

  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    sendJson(res, 200, { challenge: body.challenge });
    return;
  }

  const eventType = body?.header?.event_type ?? '';
  const eventId = body?.header?.event_id ?? null;

  if (eventType !== 'im.message.receive_v1') {
    sendJson(res, 200, { code: 0 });
    return;
  }

  if (eventId && isDuplicateLarkEvent(eventId)) {
    sendJson(res, 200, { code: 0 });
    return;
  }

  sendJson(res, 200, { code: 0 });
  void processLarkMessageEvent(body).catch(err => {
    process.stderr.write(`telegram-codex-bridge: lark event processing failed: ${err?.stack ?? err}\n`);
  });
}

async function processLarkMessageEvent(body) {
  const event = body?.event;
  const message = event?.message;
  const sender = event?.sender;
  const chatId = message?.chat_id;
  const senderOpenId = sender?.sender_id?.open_id;
  const chatType = message?.chat_type ?? 'unknown';

  if (!chatId || !senderOpenId) {
    return;
  }
  if (!isLarkUserAllowed(senderOpenId)) {
    await sendLarkText(
      chatId,
      `This bot is not allowlisted.\nYour Lark open_id is: ${senderOpenId}`,
    ).catch(() => {});
    return;
  }
  if (!LARK_ALLOW_GROUPS && chatType !== 'p2p') {
    return;
  }

  const parsed = parseLarkMessage(message);
  if (!parsed) {
    return;
  }

  if (parsed.command === 'start') {
    await sendLarkText(
      chatId,
      [
        'Lark Codex bridge is online.',
        '',
        'Send a normal text message to start a Codex session in this chat.',
        'Later messages resume the same Codex session.',
        'Commands:',
        '/status - show current chat status',
        '/reset - drop this chat session and start fresh',
      ].join('\n'),
    );
    return;
  }

  const chatKey = `lark:${chatId}`;

  if (parsed.command === 'status') {
    const text = await renderStatusText(chatKey, {
      channelLabel: 'lark',
      chatId,
      userId: senderOpenId,
    });
    await sendLarkText(chatId, text);
    return;
  }

  if (parsed.command === 'reset') {
    await stateStore.reset(chatKey);
    await sendLarkText(
      chatId,
      'Session cleared for this chat. The next message will start a fresh Codex session.',
    );
    return;
  }

  if (parsed.unsupportedNotice) {
    await sendLarkText(chatId, parsed.unsupportedNotice);
    return;
  }

  void queueManager.enqueue(
    chatKey,
    () => sendLarkText(chatId, 'Previous request is still running. Your message has been queued.'),
    async () => {
      await handleBridgeMessage({
        chatKey,
        payload: {
          text: parsed.text,
          attachments: [],
          imagePaths: [],
        },
        createPending: async resume => {
          const pendingText = resume
            ? 'Received. Resuming Codex session...'
            : 'Received. Starting Codex session...';
          await sendLarkText(chatId, pendingText);
          return null;
        },
        startProgress: () => () => {},
        sendResponse: async (_pending, text) => {
          await sendLarkText(chatId, text);
        },
      });
    },
  );
}

function parseLarkMessage(message) {
  if (message?.message_type !== 'text') {
    return {
      unsupportedNotice: `Lark message type "${message?.message_type ?? 'unknown'}" is not supported yet. Send plain text for now.`,
    };
  }

  let content;
  try {
    content = JSON.parse(message.content ?? '{}');
  } catch {
    content = {};
  }

  const text = String(content.text ?? '').trim();
  if (!text) {
    return null;
  }

  if (text === '/start') return { command: 'start' };
  if (text === '/status') return { command: 'status' };
  if (text === '/reset') return { command: 'reset' };
  return { text };
}

async function handleBridgeMessage({
  chatKey,
  payload,
  createPending,
  startProgress,
  sendResponse,
}) {
  const state = await stateStore.read(chatKey);
  const userTurn = {
    role: 'user',
    text: payload.text,
    ts: new Date().toISOString(),
    attachments: payload.attachments,
  };

  const prompt = codexRuntime.buildPrompt({
    bridgeLabel: BRIDGE_PLATFORM,
    messageText: payload.text,
    attachments: payload.attachments,
    maxPromptChars: MAX_PROMPT_CHARS,
  });
  const pending = await createPending(Boolean(state.sessionId));
  const stopProgress = startProgress();

  let finalText;
  let result;

  try {
    result = await codexRuntime.runCodex(prompt, payload.imagePaths, state.sessionId);
    finalText = codexRuntime.renderResult(result, MAX_OUTPUT_CHARS);
  } catch (err) {
    finalText = `Codex failed to start.\n\n${err instanceof Error ? err.message : String(err)}`;
  } finally {
    stopProgress();
  }

  if (result?.threadId) {
    state.sessionId = result.threadId;
  }
  state.turnCount = (state.turnCount ?? 0) + 1;
  state.history.push(userTurn);
  state.history.push({
    role: 'assistant',
    text: finalText,
    ts: new Date().toISOString(),
    attachments: [],
  });
  state.history = state.history.slice(-50);
  await stateStore.write(chatKey, state);

  await sendResponse(pending, finalText);
}

async function renderStatusText(chatKey, { channelLabel, chatId, userId }) {
  const state = await stateStore.read(chatKey);
  return [
    `channel: ${channelLabel}`,
    `chat_id: ${chatId}`,
    `user_id: ${userId}`,
    `session_mode: resume`,
    `session_id: ${state.sessionId ?? '(none)'}`,
    `turn_count: ${state.turnCount}`,
    `local_history_messages: ${state.history.length}`,
    `workdir: ${CODEX_WORKDIR}`,
    `state_dir: ${STATE_DIR}`,
    `bypass_approvals_and_sandbox: ${CODEX_BYPASS_APPROVALS_AND_SANDBOX ? 'on' : 'off'}`,
    `approval_mode: ${CODEX_APPROVAL_MODE}`,
    `sandbox_mode: ${CODEX_SANDBOX_MODE}`,
  ].join('\n');
}

function startTelegramTyping(chatId) {
  const timer = setInterval(() => {
    void bot?.api.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);

  return () => clearInterval(timer);
}

async function sendTelegramResponse(ctx, pendingMessageId, text) {
  const chunks = splitText(text, TELEGRAM_CHUNK_LIMIT);

  if (chunks.length === 0) {
    chunks.push('(empty response)');
  }

  if (pendingMessageId != null) {
    try {
      await bot.api.editMessageText(String(ctx.chat.id), pendingMessageId, renderTelegramHtml(chunks[0]), {
        parse_mode: 'HTML',
      });
    } catch {
      await ctx.reply(renderTelegramHtml(chunks[0]), {
        parse_mode: 'HTML',
      });
    }
  } else {
    await ctx.reply(renderTelegramHtml(chunks[0]), {
      parse_mode: 'HTML',
    });
  }

  for (let i = 1; i < chunks.length; i += 1) {
    await ctx.reply(renderTelegramHtml(chunks[i]), {
      parse_mode: 'HTML',
    });
  }
}

async function sendLarkText(chatId, text) {
  const chunks = splitText(text, LARK_CHUNK_LIMIT);
  const token = await getLarkTenantAccessToken();

  for (const chunk of chunks.length > 0 ? chunks : ['(empty response)']) {
    const response = await fetch(`${LARK_API_ROOT}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(
        `Lark send message failed with HTTP ${response.status}: ${data.msg ?? response.statusText}`,
      );
    }
  }
}

async function getLarkTenantAccessToken() {
  if (larkAccessTokenCache && larkAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return larkAccessTokenCache.value;
  }

  const response = await fetch(`${LARK_API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0 || typeof data.tenant_access_token !== 'string') {
    throw new Error(
      `Lark tenant_access_token request failed with HTTP ${response.status}: ${data.msg ?? response.statusText}`,
    );
  }

  larkAccessTokenCache = {
    value: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expire ?? 7200) - 60) * 1000,
  };
  return larkAccessTokenCache.value;
}

async function downloadTelegramFile(fileId, preferredName) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path for this attachment.');
  }

  const buffer = await downloadTelegramBuffer(`${TELEGRAM_FILE_ROOT}/bot${TELEGRAM_TOKEN}/${file.file_path}`);
  const safeBase = safeStem(preferredName ?? file.file_unique_id ?? 'file');
  const ext = sanitizeExt(extname(preferredName ?? file.file_path));
  const target = join(INBOX_DIR, `${Date.now()}-${safeBase}${ext}`);

  await writeFile(target, buffer);
  return target;
}

function isTelegramUserAllowed(userId) {
  return userId != null && TELEGRAM_ALLOWED_USER_IDS.has(String(userId));
}

function isLarkUserAllowed(openId) {
  return openId != null && LARK_ALLOWED_OPEN_IDS.has(String(openId));
}

function isDuplicateLarkEvent(eventId) {
  const now = Date.now();
  for (const [key, expiresAt] of seenLarkEvents) {
    if (expiresAt <= now) {
      seenLarkEvents.delete(key);
    }
  }

  if (seenLarkEvents.has(eventId)) {
    return true;
  }

  seenLarkEvents.set(eventId, now + 10 * 60 * 1000);
  return false;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';

    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeWebhookPath(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '/webhook/lark';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCodexApprovalMode(explicitValue, legacyFullAutoValue) {
  const explicit = explicitValue?.trim().toLowerCase();
  if (explicit === 'never' || explicit === 'on-request' || explicit === 'on-failure' || explicit === 'untrusted') {
    return explicit;
  }
  if (explicit) {
    process.stderr.write(
      `telegram-codex-bridge: unsupported CODEX_APPROVAL_MODE "${explicitValue}", falling back to compatibility mode.\n`,
    );
  }
  return parseBool(legacyFullAutoValue ?? '1') ? 'never' : 'on-request';
}

function normalizeCodexSandboxMode(explicitValue, legacySandboxValue) {
  const value = (explicitValue ?? legacySandboxValue ?? 'workspace-write').trim();
  return value || 'workspace-write';
}

function parseCsv(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstEnvValue(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return null;
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function registerShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

async function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  process.stderr.write(`telegram-codex-bridge: received ${signal}, stopping bridge...\n`);

  try {
    if (bot) {
      await bot.stop();
    }
    if (larkServer) {
      await new Promise((resolve, reject) => {
        larkServer.close(err => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  } catch (err) {
    process.stderr.write(`telegram-codex-bridge: shutdown error: ${err?.stack ?? err}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write('telegram-codex-bridge: bridge stopped.\n');
  process.exit(0);
}

function buildTelegramFetchAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!TELEGRAM_API_ROOT.startsWith('https://')) {
    throw new Error('TELEGRAM_PROXY_URL currently supports only HTTPS TELEGRAM_API_ROOT values.');
  }
  const proxy = new URL(proxyUrl);
  const agent = new https.Agent({ keepAlive: true });
  agent.createConnection = (options, callback) => {
    createProxyTlsSocket(proxy, options)
      .then(socket => callback(null, socket))
      .catch(error => callback(error));
    return undefined;
  };
  return agent;
}

async function createProxyTlsSocket(proxy, options) {
  const proxySocket = await connectToProxy(proxy);
  const targetHost = options.host ?? options.hostname;
  const targetPort = Number(options.port ?? 443);

  await openHttpTunnel(proxySocket, proxy, targetHost, targetPort);

  return await new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: proxySocket,
      servername: options.servername ?? targetHost,
      rejectUnauthorized: options.rejectUnauthorized,
    });

    tlsSocket.once('secureConnect', () => resolve(tlsSocket));
    tlsSocket.once('error', reject);
  });
}

async function connectToProxy(proxy) {
  const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));

  return await new Promise((resolve, reject) => {
    const socket =
      proxy.protocol === 'https:'
        ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname })
        : net.connect({ host: proxy.hostname, port });

    const readyEvent = proxy.protocol === 'https:' ? 'secureConnect' : 'connect';

    socket.once(readyEvent, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function openHttpTunnel(socket, proxy, targetHost, targetPort) {
  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString('base64')}\r\n`
      : '';

  const request =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    'Proxy-Connection: keep-alive\r\n' +
    `${auth}\r\n`;

  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    };

    const fail = error => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onError = error => fail(error);
    const onEnd = () => fail(new Error('Proxy closed the tunnel before CONNECT completed.'));
    const onClose = () => fail(new Error('Proxy connection closed before CONNECT completed.'));
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker === -1) return;

      cleanup();
      const header = buffer.slice(0, marker).toString('latin1');
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(header);
      if (!match) {
        socket.destroy();
        reject(new Error(`Invalid proxy CONNECT response: ${header.split('\r\n')[0] ?? '(empty)'}`));
        return;
      }

      const statusCode = Number(match[1]);
      if (statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${statusCode}.`));
        return;
      }

      const rest = buffer.subarray(marker + 4);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve();
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.write(request);
  });
}

async function downloadTelegramBuffer(url) {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(
      target,
      TELEGRAM_FETCH_AGENT ? { agent: TELEGRAM_FETCH_AGENT } : undefined,
      response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed with HTTP ${response.statusCode ?? 'unknown'}.`));
          return;
        }

        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      },
    );

    request.on('error', reject);
  });
}

function safeName(value) {
  return value?.replace(/[^\w.-]+/g, '_');
}

function safeStem(value) {
  const cleaned = safeName(value?.replace(/\.[^.]+$/, '')) || 'file';
  return cleaned.slice(0, 80);
}

function sanitizeExt(ext) {
  const cleaned = ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase();
  return cleaned || '';
}

function isImagePath(path) {
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(path).toLowerCase());
}

function loadEnvFile(file) {
  try {
    chmodSync(file, 0o600);
  } catch {}

  try {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const match = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
      if (!match) continue;
      if (process.env[match[1]] !== undefined) continue;

      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {}
}
