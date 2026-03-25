#!/usr/bin/env node

import * as Lark from '@larksuiteoapi/node-sdk';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

import {
  createChatQueueManager,
  createChatStateStore,
  createCodexRuntime,
} from '../../codex-runtime.mjs';
import {
  buildFeishuMarkdownCard,
  buildFeishuPostMessage,
  shouldUseFeishuCard,
} from '../../bridge-rich-text.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(__filename);

loadEnvFile(join(PROJECT_ROOT, '.env'));

const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.codex-feishu-bridge');
loadEnvFile(join(STATE_DIR, '.env'));

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN?.trim() || null;
const FEISHU_SUBSCRIPTION_MODE = normalizeSubscriptionMode(
  process.env.FEISHU_SUBSCRIPTION_MODE ?? 'websocket',
);
const FEISHU_DOMAIN = normalizeDomain(process.env.FEISHU_DOMAIN ?? 'feishu');
const FEISHU_SDK_DOMAIN = getSdkDomain(FEISHU_DOMAIN);
const FEISHU_API_ROOT = getApiRoot(FEISHU_DOMAIN);
const FEISHU_WEBHOOK_HOST = process.env.FEISHU_WEBHOOK_HOST ?? '127.0.0.1';
const FEISHU_WEBHOOK_PORT = positiveInt(process.env.FEISHU_WEBHOOK_PORT, 3000);
const FEISHU_WEBHOOK_PATH = normalizePath(process.env.FEISHU_WEBHOOK_PATH ?? '/feishu/events');
const FEISHU_ALLOW_FROM = new Set(parseCsv(process.env.FEISHU_ALLOW_FROM));
const FEISHU_GROUP_POLICY = normalizeGroupPolicy(process.env.FEISHU_GROUP_POLICY ?? 'open');
const FEISHU_GROUP_ALLOW_FROM = new Set(parseCsv(process.env.FEISHU_GROUP_ALLOW_FROM));
const FEISHU_REQUIRE_MENTION = parseBool(process.env.FEISHU_REQUIRE_MENTION ?? '0');
const FEISHU_BOT_OPEN_ID = process.env.FEISHU_BOT_OPEN_ID?.trim() || null;
const FEISHU_USER_WORKDIR_MAP = parseKeyValueMap(process.env.FEISHU_USER_WORKDIR_MAP);
const FEISHU_RESOLVE_SENDER_NAMES = parseBool(process.env.FEISHU_RESOLVE_SENDER_NAMES ?? '0');
const FEISHU_STREAMING = parseBool(process.env.FEISHU_STREAMING ?? '1');
const FEISHU_STREAM_UPDATE_MS = positiveInt(process.env.FEISHU_STREAM_UPDATE_MS, 800);

const CHAT_DIR = join(STATE_DIR, 'chats');
const RUN_DIR = join(STATE_DIR, 'runs');
const BOT_OPEN_ID_PATH = join(STATE_DIR, 'bot-open-id.txt');

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
const TEXT_CHUNK_LIMIT = 2000;

const seenEvents = new Map();
let accessTokenCache = null;
let server = null;
let wsClient = null;
let shutdownRequested = false;
let effectiveBotOpenId = FEISHU_BOT_OPEN_ID;
const stateStore = createChatStateStore(CHAT_DIR);
const queueManager = createChatQueueManager({ logPrefix: 'codex-feishu-bridge' });
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

validateConfig();
registerShutdownHandlers();

await Promise.all([
  mkdir(STATE_DIR, { recursive: true }),
  mkdir(CHAT_DIR, { recursive: true }),
  mkdir(RUN_DIR, { recursive: true }),
]);
effectiveBotOpenId = effectiveBotOpenId ?? (await loadRememberedBotOpenId());

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async data => {
    await processMessageEvent({ event: data, source: FEISHU_SUBSCRIPTION_MODE });
  },
});

if (FEISHU_SUBSCRIPTION_MODE === 'webhook') {
  server = http.createServer((req, res) => {
    void handleHttp(req, res).catch(err => {
      process.stderr.write(`codex-feishu-bridge: request failed: ${err?.stack ?? err}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { code: 500, msg: 'internal error' });
      } else {
        res.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FEISHU_WEBHOOK_PORT, FEISHU_WEBHOOK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
} else {
  wsClient = new Lark.WSClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    appType: Lark.AppType.SelfBuild,
    domain: FEISHU_SDK_DOMAIN,
    loggerLevel: Lark.LoggerLevel.info,
  });
  wsClient.start({ eventDispatcher });
}

process.stderr.write('codex-feishu-bridge: started\n');
process.stderr.write(`codex-feishu-bridge: subscription_mode ${FEISHU_SUBSCRIPTION_MODE}\n`);
process.stderr.write(`codex-feishu-bridge: domain ${FEISHU_DOMAIN}\n`);
if (FEISHU_SUBSCRIPTION_MODE === 'webhook') {
  process.stderr.write(
    `codex-feishu-bridge: webhook http://${FEISHU_WEBHOOK_HOST}:${FEISHU_WEBHOOK_PORT}${FEISHU_WEBHOOK_PATH}\n`,
  );
}
process.stderr.write(`codex-feishu-bridge: api_root ${FEISHU_API_ROOT}\n`);
process.stderr.write(`codex-feishu-bridge: workdir ${CODEX_WORKDIR}\n`);
process.stderr.write(`codex-feishu-bridge: state_dir ${STATE_DIR}\n`);

function validateConfig() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    process.stderr.write('codex-feishu-bridge: FEISHU_APP_ID and FEISHU_APP_SECRET are required.\n');
    process.exit(1);
  }
  if (FEISHU_ALLOW_FROM.size === 0) {
    process.stderr.write('codex-feishu-bridge: FEISHU_ALLOW_FROM is required for safety.\n');
    process.exit(1);
  }
}

async function handleHttp(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (req.method !== 'POST' || pathname !== FEISHU_WEBHOOK_PATH) {
    sendJson(res, 404, { code: 404, msg: 'not found' });
    return;
  }

  const body = await readJsonBody(req);

  if (body?.encrypt) {
    sendJson(res, 400, {
      code: 400,
      msg: 'encrypted callbacks are not supported yet; disable Encrypt Key first',
    });
    return;
  }

  const callbackToken = body?.header?.token ?? body?.token ?? null;
  if (FEISHU_VERIFICATION_TOKEN && callbackToken !== FEISHU_VERIFICATION_TOKEN) {
    sendJson(res, 403, { code: 403, msg: 'invalid verification token' });
    return;
  }

  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    sendJson(res, 200, { challenge: body.challenge });
    return;
  }

  const result = await eventDispatcher.invoke(body);
  sendJson(res, 200, result ?? { code: 0 });
}

async function processMessageEvent(payload) {
  const event = payload?.event ?? {};
  const eventId = payload?.header?.event_id ?? payload?.event_id ?? null;
  if (eventId && isDuplicateEvent(eventId)) {
    return;
  }

  const message = event.message ?? {};
  const sender = event.sender ?? {};
  const senderOpenId = sender.sender_id?.open_id;
  const senderName = FEISHU_RESOLVE_SENDER_NAMES
    ? sender.sender_id?.user_id ?? sender.sender_id?.union_id ?? senderOpenId ?? 'unknown'
    : null;
  const chatId = message.chat_id;
  const chatType = message.chat_type ?? 'unknown';

  if (!senderOpenId || !chatId) {
    return;
  }

  if (message.message_type !== 'text') {
    await safeSendText(
      chatId,
      `Unsupported message type "${message.message_type ?? 'unknown'}". Send plain text.`,
      'unsupported_message_type',
    );
    return;
  }

  if (chatType === 'p2p') {
    if (!FEISHU_ALLOW_FROM.has(senderOpenId)) {
      await safeSendText(
        chatId,
        `This bot is not allowlisted.\nYour open_id is: ${senderOpenId}`,
        'allowlist_reject',
      );
      return;
    }
  } else if (!isGroupAllowed(chatId)) {
    return;
  }

  const parsed = parseIncomingText(message);
  await rememberBotOpenIdCandidate(parsed);
  if (!parsed.text) {
    return;
  }

  if (chatType !== 'p2p' && FEISHU_REQUIRE_MENTION && !isBotMentioned(parsed)) {
    return;
  }

  if (parsed.command === 'start') {
    await sendText(
      chatId,
      [
        'Codex Feishu bridge is online.',
        '',
        'Send a normal text message to start a Codex session in this chat.',
        'Later messages resume the same Codex session.',
        'Commands:',
        '/status - show current chat status',
        '/reset - clear this chat session',
      ].join('\n'),
    );
    return;
  }

  const effectiveWorkdir = resolveWorkdirForSender(senderOpenId);
  const chatKey = buildChatKey(chatType, chatId, senderOpenId, effectiveWorkdir);
  if (parsed.command === 'status') {
    await sendText(chatId, await renderStatusText(chatKey, chatId, senderOpenId, effectiveWorkdir));
    return;
  }
  if (parsed.command === 'reset') {
    await stateStore.reset(chatKey);
    await sendText(chatId, 'Session cleared for this chat. The next message will start a fresh Codex session.');
    return;
  }

  void queueManager.enqueue(
    chatKey,
    () => sendText(chatId, 'Previous request is still running. Your message has been queued.'),
    async () => {
      const state = await stateStore.read(chatKey);
      const pendingText = state.sessionId
        ? 'Received. Resuming Codex session...'
        : 'Received. Starting Codex session...';
      const progress = FEISHU_STREAMING
        ? await createStreamingResponder(chatId, pendingText)
        : await createSimpleResponder(chatId, pendingText);

      const payload = {
        text: parsed.text,
        senderOpenId,
        senderName,
        chatType,
      };

      const userTurn = {
        role: 'user',
        text: parsed.text,
        ts: new Date().toISOString(),
      };

      let finalText;
      let result;

      try {
        result = await codexRuntime.runCodex(
          codexRuntime.buildPrompt({
            bridgeLabel: 'feishu',
            messageText: payload.text,
            extraContext: [
              `Channel domain: ${FEISHU_DOMAIN}`,
              `Chat type: ${payload.chatType}`,
              `Sender open_id: ${payload.senderOpenId}`,
              payload.senderName ? `Sender label: ${payload.senderName}` : '',
            ],
            maxPromptChars: MAX_PROMPT_CHARS,
            workdir: effectiveWorkdir,
          }),
          [],
          state.sessionId,
          progress,
          { workdir: effectiveWorkdir },
        );
        finalText = codexRuntime.renderResult(result, MAX_OUTPUT_CHARS);
      } catch (err) {
        finalText = `Codex failed to start.\n\n${err instanceof Error ? err.message : String(err)}`;
      } finally {
        await progress.close();
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
      });
      state.history = state.history.slice(-50);
      await stateStore.write(chatKey, state);

      await progress.final(finalText);
    },
  );
}

function isGroupAllowed(chatId) {
  if (FEISHU_GROUP_POLICY === 'disabled') return false;
  if (FEISHU_GROUP_POLICY === 'open') return true;
  return FEISHU_GROUP_ALLOW_FROM.has(chatId);
}

function parseIncomingText(message) {
  let content;
  try {
    content = JSON.parse(message.content ?? '{}');
  } catch {
    content = {};
  }

  const rawText = String(content.text ?? '').trim();
  const text = rawText.replace(/<at[^>]*>.*?<\/at>/g, ' ').replace(/\s+/g, ' ').trim();
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const hasMention = mentions.length > 0 ? true : /<at\b/i.test(rawText);
  const mentionedOpenIds = mentions
    .map(mention => mention?.id?.open_id)
    .filter(openId => typeof openId === 'string' && openId.length > 0);

  return {
    text,
    hasMention,
    mentionedOpenIds,
    command: text === '/start' || text === '/status' || text === '/reset' ? text.slice(1) : null,
  };
}

function isBotMentioned(parsed) {
  if (!parsed.hasMention) return false;
  if (!effectiveBotOpenId) return true;
  return parsed.mentionedOpenIds.includes(effectiveBotOpenId);
}

function buildChatKey(chatType, chatId, senderOpenId, workdir) {
  if (chatType === 'p2p') {
    return `feishu:${chatType}:${chatId}:${workdir}`;
  }
  return `feishu:${chatType}:${chatId}:${senderOpenId}:${workdir}`;
}

async function loadRememberedBotOpenId() {
  try {
    const value = (await readFile(BOT_OPEN_ID_PATH, 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function rememberBotOpenIdCandidate(parsed) {
  if (effectiveBotOpenId) return;
  if (!parsed.hasMention) return;
  if (parsed.mentionedOpenIds.length !== 1) return;
  const candidate = parsed.mentionedOpenIds[0];
  effectiveBotOpenId = candidate;
  try {
    await writeFile(BOT_OPEN_ID_PATH, `${candidate}\n`);
    process.stderr.write(`codex-feishu-bridge: remembered bot_open_id ${candidate}\n`);
  } catch (err) {
    process.stderr.write(
      `codex-feishu-bridge: failed to persist bot_open_id ${candidate}: ${err?.stack ?? err}\n`,
    );
  }
}

async function renderStatusText(chatKey, chatId, userId, effectiveWorkdir) {
  const state = await stateStore.read(chatKey);
  return [
    'channel: feishu',
    `chat_id: ${chatId}`,
    `user_id: ${userId}`,
    `session_mode: resume`,
    `session_id: ${state.sessionId ?? '(none)'}`,
    `turn_count: ${state.turnCount}`,
    `local_history_messages: ${state.history.length}`,
    `workdir: ${effectiveWorkdir}`,
    `default_workdir: ${CODEX_WORKDIR}`,
    `state_dir: ${STATE_DIR}`,
    `bypass_approvals_and_sandbox: ${CODEX_BYPASS_APPROVALS_AND_SANDBOX ? 'on' : 'off'}`,
    `approval_mode: ${CODEX_APPROVAL_MODE}`,
    `sandbox_mode: ${CODEX_SANDBOX_MODE}`,
    `domain: ${FEISHU_DOMAIN}`,
    `group_policy: ${FEISHU_GROUP_POLICY}`,
  ].join('\n');
}

async function sendText(chatId, text) {
  const token = await getTenantAccessToken();
  const chunks = splitText(text, TEXT_CHUNK_LIMIT);
  let lastMessageId = null;

  for (const chunk of chunks.length > 0 ? chunks : ['(empty response)']) {
    const useCard = shouldUseFeishuCard(chunk);
    if (useCard) {
      const interactive = await sendMessageByType(chatId, 'interactive', buildFeishuMarkdownCard(chunk), token);
      if (interactive.ok) {
        lastMessageId = interactive.messageId ?? lastMessageId;
        continue;
      }
    }

    const post = await sendMessageByType(chatId, 'post', buildFeishuPostMessage(chunk), token);
    if (post.ok) {
      lastMessageId = post.messageId ?? lastMessageId;
      continue;
    }

    const fallback = await sendPlainText(chatId, chunk, token);
    lastMessageId = fallback ?? lastMessageId;
  }

  return lastMessageId;
}

async function safeSendText(chatId, text, reason) {
  try {
    return await sendText(chatId, text);
  } catch (err) {
    process.stderr.write(
      `codex-feishu-bridge: reply failed (${reason}) for chat ${chatId}: ${err?.stack ?? err}\n`,
    );
    return null;
  }
}

async function updateText(messageId, text) {
  if (!messageId) return false;

  const token = await getTenantAccessToken();
  if (shouldUseFeishuCard(text)) {
    const interactive = await updateMessageByType(
      messageId,
      'interactive',
      buildFeishuMarkdownCard(text),
      token,
    );
    if (interactive) return true;
  }
  return await updateMessageByType(messageId, 'post', buildFeishuPostMessage(text), token);
}

async function sendPlainText(chatId, text, token) {
  const resolvedToken = token ?? (await getTenantAccessToken());
  const response = await fetch(`${FEISHU_API_ROOT}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    throw new Error(
      `send message failed with HTTP ${response.status}: ${data.msg ?? response.statusText}`,
    );
  }

  return data.data?.message_id ?? null;
}

async function sendMessageByType(chatId, msgType, content, token) {
  const response = await fetch(`${FEISHU_API_ROOT}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
    }),
  });

  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && data.code === 0,
    messageId: data.data?.message_id ?? null,
    response,
    data,
  };
}

async function updateMessageByType(messageId, msgType, content, token) {
  const response = await fetch(`${FEISHU_API_ROOT}/im/v1/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      msg_type: msgType,
      content: JSON.stringify(content),
    }),
  });

  const data = await response.json().catch(() => ({}));
  return response.ok && data.code === 0;
}

async function getTenantAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.value;
  }

  const response = await fetch(`${FEISHU_API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0 || typeof data.tenant_access_token !== 'string') {
    throw new Error(
      `tenant_access_token request failed with HTTP ${response.status}: ${data.msg ?? response.statusText}`,
    );
  }

  accessTokenCache = {
    value: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expire ?? 7200) - 60) * 1000,
  };
  return accessTokenCache.value;
}


function isDuplicateEvent(eventId) {
  const now = Date.now();
  for (const [key, expiresAt] of seenEvents) {
    if (expiresAt <= now) {
      seenEvents.delete(key);
    }
  }
  if (seenEvents.has(eventId)) {
    return true;
  }
  seenEvents.set(eventId, now + 10 * 60 * 1000);
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

function normalizeDomain(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'lark' ? 'lark' : 'feishu';
}

function normalizeSubscriptionMode(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'webhook' ? 'webhook' : 'websocket';
}

function getApiRoot(domain) {
  return domain === 'lark'
    ? 'https://open.larksuite.com/open-apis'
    : 'https://open.feishu.cn/open-apis';
}

function getSdkDomain(domain) {
  return domain === 'lark' ? Lark.Domain.LarkSuite : Lark.Domain.Feishu;
}

function normalizeGroupPolicy(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'open' || normalized === 'allowlist') {
    return normalized;
  }
  return 'disabled';
}

function normalizePath(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '/feishu/events';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCodexApprovalMode(explicitValue, legacyFullAutoValue) {
  const explicit = explicitValue?.trim().toLowerCase();
  if (explicit === 'never' || explicit === 'on-request' || explicit === 'on-failure' || explicit === 'untrusted') {
    return explicit;
  }
  if (explicit) {
    process.stderr.write(
      `codex-feishu-bridge: unsupported CODEX_APPROVAL_MODE "${explicitValue}", falling back to compatibility mode.\n`,
    );
  }
  return parseBool(legacyFullAutoValue ?? '1') ? 'never' : 'on-request';
}

function normalizeCodexSandboxMode(explicitValue, legacySandboxValue) {
  const value = (explicitValue ?? legacySandboxValue ?? 'workspace-write').trim();
  return value || 'workspace-write';
}

function parseKeyValueMap(value) {
  const map = new Map();
  for (const entry of String(value ?? '').split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const mappedValue = trimmed.slice(separator + 1).trim();
    if (!key || !mappedValue) continue;
    map.set(key, mappedValue);
  }
  return map;
}

function resolveWorkdirForSender(senderOpenId) {
  return FEISHU_USER_WORKDIR_MAP.get(senderOpenId) ?? CODEX_WORKDIR;
}

function parseCsv(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitText(text, limit) {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    const paragraph = rest.lastIndexOf('\n\n', limit);
    const newline = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut =
      paragraph > limit / 2 ? paragraph : newline > limit / 2 ? newline : space > 0 ? space : limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function keepTail(text, maxLength) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

async function createSimpleResponder(chatId, pendingText) {
  await sendText(chatId, pendingText);
  return {
    async update() {},
    async note() {},
    async final(text) {
      await sendText(chatId, text);
    },
    async close() {},
  };
}

async function createStreamingResponder(chatId, pendingText) {
  const messageId = await sendText(chatId, pendingText);
  let lastRendered = pendingText;
  let lastStatus = pendingText;
  let updateTimer = null;
  let updateInFlight = Promise.resolve();
  let closed = false;
  let fallbackMode = false;

  const schedule = nextText => {
    lastRendered = nextText;
    if (closed || fallbackMode || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updateInFlight = updateInFlight.then(async () => {
        if (fallbackMode) return;
        const ok = await updateText(messageId, lastRendered).catch(() => false);
        if (!ok) {
          fallbackMode = true;
        }
      });
    }, FEISHU_STREAM_UPDATE_MS);
  };

  return {
    async update(text) {
      if (!text?.trim()) return;
      const clipped = clipStreamingText(text);
      lastStatus = clipped;
      schedule(clipped);
    },
    async note(text) {
      if (!text?.trim()) return;
      if (lastStatus && lastStatus.includes(text)) return;
      lastStatus = text;
      schedule(text);
    },
    async final(text) {
      const finalText = clipFinalText(text);
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }
      await updateInFlight;
      if (shouldUseFeishuCard(finalText)) {
        await sendText(chatId, finalText);
        return;
      }
      if (!fallbackMode) {
        const ok = await updateText(messageId, finalText).catch(() => false);
        if (ok) return;
      }
      await sendText(chatId, finalText);
    },
    async close() {
      closed = true;
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }
      await updateInFlight;
    },
  };
}

function clipStreamingText(text) {
  const normalized = String(text ?? '').trim();
  if (normalized.length <= TEXT_CHUNK_LIMIT) {
    return normalized;
  }
  return `[streaming]\n${keepTail(normalized, TEXT_CHUNK_LIMIT - 12)}`;
}

function clipFinalText(text) {
  return String(text ?? '').length > MAX_OUTPUT_CHARS
    ? `${String(text).slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated]`
    : String(text ?? '');
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
  process.stderr.write(`codex-feishu-bridge: received ${signal}, stopping...\n`);

  try {
    if (wsClient && typeof wsClient.stop === 'function') {
      await wsClient.stop();
    }
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(err => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  } catch (err) {
    process.stderr.write(`codex-feishu-bridge: shutdown error: ${err?.stack ?? err}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write('codex-feishu-bridge: stopped.\n');
  process.exit(0);
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
