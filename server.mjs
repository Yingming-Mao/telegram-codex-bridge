#!/usr/bin/env node

import {
  buildCodexArgs,
  formatTelegramStartupError,
  keepTail,
  redactUrlAuth,
  splitText,
} from './bridge-core.mjs';
import { Bot } from 'grammy';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(__filename);

loadEnvFile(join(PROJECT_ROOT, '.env'));

const STATE_DIR =
  process.env.TELEGRAM_CODEX_STATE_DIR ?? join(homedir(), '.codex-telegram-bridge');

loadEnvFile(join(STATE_DIR, '.env'));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    'telegram-codex-bridge: TELEGRAM_BOT_TOKEN is required.\n' +
      `Put it in ${join(PROJECT_ROOT, '.env')} or ${join(STATE_DIR, '.env')}.\n`,
  );
  process.exit(1);
}

const ALLOWED_USER_IDS = new Set(parseCsv(process.env.ALLOWED_TELEGRAM_USER_IDS));
if (ALLOWED_USER_IDS.size === 0) {
  process.stderr.write(
    'telegram-codex-bridge: ALLOWED_TELEGRAM_USER_IDS is required for safety.\n',
  );
  process.exit(1);
}

const CHAT_DIR = join(STATE_DIR, 'chats');
const INBOX_DIR = join(STATE_DIR, 'inbox');
const RUN_DIR = join(STATE_DIR, 'runs');

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR ?? resolve(PROJECT_ROOT, '..');
const CODEX_MODEL = process.env.CODEX_MODEL;
const CODEX_PROFILE = process.env.CODEX_PROFILE;
const CODEX_SANDBOX = process.env.CODEX_SANDBOX ?? 'workspace-write';
const CODEX_FULL_AUTO = parseBool(process.env.CODEX_FULL_AUTO ?? '1');
const CODEX_SKIP_GIT_REPO_CHECK = parseBool(process.env.CODEX_SKIP_GIT_REPO_CHECK ?? '0');
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
const MAX_PROMPT_CHARS = positiveInt(process.env.MAX_PROMPT_CHARS, 16000);
const MAX_OUTPUT_CHARS = positiveInt(process.env.MAX_OUTPUT_CHARS, 12000);
const TELEGRAM_CHUNK_LIMIT = 3800;

const TELEGRAM_FETCH_AGENT = buildTelegramFetchAgent(TELEGRAM_PROXY_URL);

const bot = new Bot(TOKEN, {
  client: {
    apiRoot: TELEGRAM_API_ROOT,
    baseFetchConfig: TELEGRAM_FETCH_AGENT ? { agent: TELEGRAM_FETCH_AGENT } : undefined,
  },
});
const chatQueues = new Map();
let shutdownRequested = false;

registerShutdownHandlers();

await Promise.all([
  mkdir(STATE_DIR, { recursive: true }),
  mkdir(CHAT_DIR, { recursive: true }),
  mkdir(INBOX_DIR, { recursive: true }),
  mkdir(RUN_DIR, { recursive: true }),
]);

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return;

  const allowed = isAllowedUser(ctx.from?.id);
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
  if (!isAllowedUser(ctx.from?.id)) {
    await ctx.reply(`This bot is not allowlisted.\nYour Telegram user ID is: ${ctx.from?.id ?? 'unknown'}`);
    return;
  }

  const state = await readChatState(String(ctx.chat.id));
  await ctx.reply(
    [
      `chat_id: ${ctx.chat.id}`,
      `user_id: ${ctx.from?.id ?? 'unknown'}`,
      `session_mode: resume`,
      `session_id: ${state.sessionId ?? '(none)'}`,
      `turn_count: ${state.turnCount}`,
      `local_history_messages: ${state.history.length}`,
      `workdir: ${CODEX_WORKDIR}`,
      `state_dir: ${STATE_DIR}`,
      `full_auto: ${CODEX_FULL_AUTO ? 'on' : 'off'}`,
      `sandbox: ${CODEX_SANDBOX}`,
    ].join('\n'),
  );
});

bot.command('reset', async ctx => {
  if (ctx.chat?.type !== 'private') return;
  if (!isAllowedUser(ctx.from?.id)) return;

  const state = await readChatState(String(ctx.chat.id));
  state.sessionId = null;
  state.turnCount = 0;
  state.history = [];
  await writeChatState(String(ctx.chat.id), state);
  await ctx.reply('Session cleared for this chat. The next message will start a fresh Codex session.');
});

bot.on('message:text', async ctx => {
  if (ctx.chat?.type !== 'private') return;
  if (!isAllowedUser(ctx.from?.id)) return;
  if (ctx.message.text.startsWith('/')) return;

  void queueChat(String(ctx.chat.id), async () => {
    await handleUserMessage(ctx, {
      text: ctx.message.text,
      attachments: [],
      imagePaths: [],
    });
  }, ctx);
});

bot.on('message:photo', async ctx => {
  if (ctx.chat?.type !== 'private') return;
  if (!isAllowedUser(ctx.from?.id)) return;

  void queueChat(String(ctx.chat.id), async () => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const imagePath = await downloadTelegramFile(photo.file_id, `${photo.file_unique_id}.jpg`);
    await handleUserMessage(ctx, {
      text: ctx.message.caption?.trim() || '(photo attached)',
      attachments: [{ kind: 'photo', path: imagePath, name: imagePath.split('/').pop() ?? 'photo' }],
      imagePaths: [imagePath],
    });
  }, ctx);
});

bot.on('message:document', async ctx => {
  if (ctx.chat?.type !== 'private') return;
  if (!isAllowedUser(ctx.from?.id)) return;

  void queueChat(String(ctx.chat.id), async () => {
    const doc = ctx.message.document;
    const filePath = await downloadTelegramFile(doc.file_id, doc.file_name ?? `${doc.file_unique_id}.bin`);
    const label = safeName(doc.file_name) ?? filePath.split('/').pop() ?? 'document';
    await handleUserMessage(ctx, {
      text: ctx.message.caption?.trim() || `(document: ${label})`,
      attachments: [{ kind: 'document', path: filePath, name: label }],
      imagePaths: isImagePath(filePath) ? [filePath] : [],
    });
  }, ctx);
});

bot.catch(err => {
  process.stderr.write(`telegram-codex-bridge: handler error: ${err.error?.stack ?? err.error ?? err}\n`);
});

await startBot();

async function queueChat(chatId, fn, ctx) {
  const wasBusy = chatQueues.has(chatId);
  if (wasBusy) {
    await ctx.reply('Previous request is still running. Your message has been queued.');
  }

  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(fn)
    .catch(err => {
      process.stderr.write(`telegram-codex-bridge: chat ${chatId} failed: ${err.stack ?? err}\n`);
    })
    .finally(() => {
      if (chatQueues.get(chatId) === next) {
        chatQueues.delete(chatId);
      }
    });

  chatQueues.set(chatId, next);
  await next;
}

async function handleUserMessage(ctx, payload) {
  const chatId = String(ctx.chat.id);
  const state = await readChatState(chatId);

  const userTurn = {
    role: 'user',
    text: payload.text,
    ts: new Date().toISOString(),
    attachments: payload.attachments,
  };

  const prompt = buildCodexPrompt(payload);
  const pending = await ctx.reply(
    state.sessionId ? 'Received. Resuming Codex session...' : 'Received. Starting Codex session...',
  );
  const stopTyping = startTyping(chatId);

  let finalText;
  let result;

  try {
    result = await runCodex(prompt, payload.imagePaths, state.sessionId);
    finalText = renderCodexResult(result);
  } catch (err) {
    finalText = `Codex failed to start.\n\n${err instanceof Error ? err.message : String(err)}`;
  } finally {
    stopTyping();
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
  await writeChatState(chatId, state);

  await sendTelegramResponse(ctx, pending.message_id, finalText);
}

function startTyping(chatId) {
  const timer = setInterval(() => {
    void bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);

  return () => clearInterval(timer);
}

async function runCodex(prompt, imagePaths, sessionId) {
  const outputPath = join(RUN_DIR, `${Date.now()}-${randomUUID()}.txt`);
  const args = buildCodexArgs({
    sessionId,
    imagePaths,
    outputPath,
    config: {
      fullAuto: CODEX_FULL_AUTO,
      model: CODEX_MODEL,
      profile: CODEX_PROFILE,
      sandbox: CODEX_SANDBOX,
      skipGitRepoCheck: CODEX_SKIP_GIT_REPO_CHECK,
      stateDir: STATE_DIR,
      workdir: CODEX_WORKDIR,
    },
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: CODEX_WORKDIR,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawStdout = '';
    let stdoutBuffer = '';
    let stderr = '';
    let threadId = sessionId ?? null;
    const agentMessages = [];
    const eventErrors = [];

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        rawStdout = keepTail(`${rawStdout}${line}\n`, 16000);
        const event = parseJsonLine(line);
        if (!event) continue;
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          threadId = event.thread_id;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          agentMessages.push(event.item.text);
        }
        if (event.type === 'error' && typeof event.message === 'string') {
          eventErrors.push(event.message);
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr = keepTail(stderr + chunk.toString('utf8'), 32000);
    });

    child.on('error', reject);

    child.on('close', async code => {
      let finalMessage = '';

      if (stdoutBuffer.trim()) {
        rawStdout = keepTail(`${rawStdout}${stdoutBuffer}\n`, 16000);
        const event = parseJsonLine(stdoutBuffer);
        if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
          threadId = event.thread_id;
        }
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          agentMessages.push(event.item.text);
        }
        if (event?.type === 'error' && typeof event.message === 'string') {
          eventErrors.push(event.message);
        }
      }

      try {
        if (existsSync(outputPath)) {
          finalMessage = (await readFile(outputPath, 'utf8')).trim();
        }
      } catch {}

      await rm(outputPath, { force: true }).catch(() => {});

      resolve({
        code: code ?? 1,
        rawStdout,
        stderr,
        finalMessage,
        threadId,
        agentMessages,
        eventErrors,
      });
    });

    child.stdin.end(prompt);
  });
}

function renderCodexResult(result) {
  const pieces = [];

  if (result.finalMessage) {
    pieces.push(result.finalMessage.trim());
  }

  if (!result.finalMessage && result.agentMessages.length > 0) {
    pieces.push(result.agentMessages[result.agentMessages.length - 1].trim());
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.eventErrors.join('\n') || result.rawStdout || '').trim();
    pieces.push(
      [
        `Codex exited with code ${result.code}.`,
        result.threadId ? 'If this looks like a stale thread, send /reset to start a fresh session.' : '',
        detail ? keepTail(detail, 3000) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  let text = pieces.filter(Boolean).join('\n\n');
  if (!text) {
    text = 'Codex finished without a final message.';
  }

  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated]`;
  }

  return text;
}

function buildCodexPrompt(payload) {
  const latestAttachments = payload.attachments?.length
    ? payload.attachments.map(att => `- ${att.kind}: ${att.path}`).join('\n')
    : 'None';
  const prefix = [
    'You are Codex CLI replying to a Telegram user through an automated bridge.',
    'Treat the Telegram message as the direct user request.',
    'Reply in plain text that reads well in Telegram.',
    'Keep the answer concise unless the user explicitly asks for detail.',
    `Your working directory is: ${CODEX_WORKDIR}`,
    `Bridge state directory is: ${STATE_DIR}`,
    'This chat reuses the same Codex session across turns until /reset is sent.',
    'If the latest message references a saved local file, inspect that path directly when needed.',
    '',
    'Latest message attachments:',
    latestAttachments,
    '',
    'Latest user message:',
  ].join('\n');
  const latestMessage = payload.text?.trim() || '(empty message)';
  const budget = Math.max(1000, MAX_PROMPT_CHARS - prefix.length);
  return `${prefix}\n${latestMessage.length > budget ? `${latestMessage.slice(0, budget)}\n\n[truncated]` : latestMessage}`;
}

async function sendTelegramResponse(ctx, pendingMessageId, text) {
  const chunks = splitText(text, TELEGRAM_CHUNK_LIMIT);

  if (chunks.length === 0) {
    chunks.push('(empty response)');
  }

  try {
    await bot.api.editMessageText(String(ctx.chat.id), pendingMessageId, chunks[0]);
  } catch {
    await ctx.reply(chunks[0]);
  }

  for (let i = 1; i < chunks.length; i += 1) {
    await ctx.reply(chunks[i]);
  }
}

async function downloadTelegramFile(fileId, preferredName) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path for this attachment.');
  }

  const buffer = await downloadTelegramBuffer(
    `${TELEGRAM_FILE_ROOT}/bot${TOKEN}/${file.file_path}`,
  );
  const safeBase = safeStem(preferredName ?? file.file_unique_id ?? 'file');
  const ext = sanitizeExt(extname(preferredName ?? file.file_path));
  const target = join(INBOX_DIR, `${Date.now()}-${safeBase}${ext}`);

  await writeFile(target, buffer);
  return target;
}

async function readChatState(chatId) {
  const path = join(CHAT_DIR, `${chatId}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      sessionId:
        typeof parsed.sessionId === 'string'
          ? parsed.sessionId
          : typeof parsed.threadId === 'string'
            ? parsed.threadId
            : null,
      turnCount: Number.isFinite(parsed.turnCount) ? parsed.turnCount : 0,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { sessionId: null, turnCount: 0, history: [] };
  }
}

async function writeChatState(chatId, state) {
  const path = join(CHAT_DIR, `${chatId}.json`);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function isAllowedUser(userId) {
  return userId != null && ALLOWED_USER_IDS.has(String(userId));
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

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
  process.stderr.write(`telegram-codex-bridge: received ${signal}, stopping bot...\n`);

  try {
    await bot.stop();
  } catch (err) {
    process.stderr.write(`telegram-codex-bridge: shutdown error: ${err?.stack ?? err}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write('telegram-codex-bridge: bot stopped.\n');
  process.exit(0);
}

async function startBot() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Show help' },
      { command: 'status', description: 'Show chat status' },
      { command: 'reset', description: 'Reset this chat session' },
    ]);

    await bot.start({
      onStart: info => {
        process.stderr.write(`telegram-codex-bridge: polling as @${info.username}\n`);
        process.stderr.write(`telegram-codex-bridge: workdir ${CODEX_WORKDIR}\n`);
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
