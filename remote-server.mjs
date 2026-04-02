#!/usr/bin/env node

import { hostname } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createChatQueueManager,
  createChatStateStore,
  createCodexRuntime,
} from './codex-runtime.mjs';
import {
  buildAuthHeaders,
  createJsonLineParser,
  loadEnvFile,
  normalizeCodexApprovalMode,
  normalizeCodexSandboxMode,
  parseBool,
  positiveInt,
} from './remote-common.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(__filename);

loadEnvFile(join(PROJECT_ROOT, '.env'));

const STATE_DIR = process.env.REMOTE_SERVER_STATE_DIR ?? join(homedir(), '.codex-remote-server');
loadEnvFile(join(STATE_DIR, '.env'));

const CHAT_DIR = join(STATE_DIR, 'chats');
const RUN_DIR = join(STATE_DIR, 'runs');

const REMOTE_CLIENT_URL = stripTrailingSlash(process.env.REMOTE_CLIENT_URL ?? '');
const REMOTE_AGENT_PATH = normalizePath(process.env.REMOTE_AGENT_PATH ?? '/remote/agent/connect');
const REMOTE_EVENT_PATH = normalizePath(process.env.REMOTE_EVENT_PATH ?? '/remote/agent/events');
const REMOTE_SERVER_ID = process.env.REMOTE_SERVER_ID?.trim() || hostname();
const REMOTE_SHARED_SECRET = process.env.REMOTE_SHARED_SECRET?.trim() || null;
const REMOTE_RECONNECT_DELAY_MS = positiveInt(process.env.REMOTE_RECONNECT_DELAY_MS, 3000);
const REMOTE_PROGRESS_UPDATE_MS = positiveInt(process.env.REMOTE_PROGRESS_UPDATE_MS, 1000);

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
  'remote-server',
);
const CODEX_SANDBOX_MODE = normalizeCodexSandboxMode(
  process.env.CODEX_SANDBOX_MODE,
  process.env.CODEX_SANDBOX,
);
const CODEX_SKIP_GIT_REPO_CHECK = parseBool(process.env.CODEX_SKIP_GIT_REPO_CHECK ?? '0');
const MAX_PROMPT_CHARS = positiveInt(process.env.MAX_PROMPT_CHARS, 16000);
const MAX_OUTPUT_CHARS = positiveInt(process.env.MAX_OUTPUT_CHARS, 12000);

if (!REMOTE_CLIENT_URL) {
  process.stderr.write('remote-server: REMOTE_CLIENT_URL is required.\n');
  process.exit(1);
}
if (!REMOTE_SHARED_SECRET) {
  process.stderr.write('remote-server: REMOTE_SHARED_SECRET is required.\n');
  process.exit(1);
}

const stateStore = createChatStateStore(CHAT_DIR);
const queueManager = createChatQueueManager({ logPrefix: 'remote-server' });
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

let shutdownRequested = false;
registerShutdownHandlers();

await ensureStateDirs();

process.stderr.write(`remote-server: client ${REMOTE_CLIENT_URL}\n`);
process.stderr.write(`remote-server: server_id ${REMOTE_SERVER_ID}\n`);
process.stderr.write(`remote-server: workdir ${CODEX_WORKDIR}\n`);
process.stderr.write(`remote-server: state_dir ${STATE_DIR}\n`);

while (!shutdownRequested) {
  try {
    await connectAndServe();
  } catch (err) {
    if (shutdownRequested) break;
    process.stderr.write(`remote-server: connection failed: ${err?.stack ?? err}\n`);
  }

  if (!shutdownRequested) {
    await delay(REMOTE_RECONNECT_DELAY_MS);
  }
}

async function connectAndServe() {
  const headers = {
    ...buildAuthHeaders({
      serverId: REMOTE_SERVER_ID,
      sharedSecret: REMOTE_SHARED_SECRET,
    }),
    'x-codex-hostname': hostname(),
    'x-codex-agent-version': '0.1.0',
    'x-codex-workdir': CODEX_WORKDIR,
  };

  const response = await fetch(`${REMOTE_CLIENT_URL}${REMOTE_AGENT_PATH}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`connect failed with HTTP ${response.status}: ${detail || response.statusText}`);
  }

  process.stderr.write('remote-server: connected\n');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createJsonLineParser(message => {
    void handleClientMessage(message).catch(err => {
      process.stderr.write(`remote-server: command failed: ${err?.stack ?? err}\n`);
    });
  });

  while (!shutdownRequested) {
    const { value, done } = await reader.read();
    if (done) break;
    parse(decoder.decode(value, { stream: true }));
  }

  process.stderr.write('remote-server: disconnected\n');
}

async function handleClientMessage(message) {
  const type = String(message?.type ?? '').trim();
  const requestId = String(message?.request_id ?? '').trim();

  if (type === 'hello_ack' || type === 'ping') {
    return;
  }

  if (!type || !requestId) {
    return;
  }

  if (type === 'status') {
    const chatKey = String(message?.chat_key ?? '').trim();
    if (!chatKey) {
      await postEvent({ type: 'error', request_id: requestId, error: 'chat_key is required' });
      return;
    }
    await postEvent({
      type: 'status_result',
      request_id: requestId,
      chat_key: chatKey,
      status_text: await renderStatusText(chatKey),
    });
    return;
  }

  if (type === 'reset') {
    const chatKey = String(message?.chat_key ?? '').trim();
    if (!chatKey) {
      await postEvent({ type: 'error', request_id: requestId, error: 'chat_key is required' });
      return;
    }
    await stateStore.reset(chatKey);
    await postEvent({
      type: 'reset_result',
      request_id: requestId,
      chat_key: chatKey,
      message: 'Session cleared. The next message will start a fresh Codex session.',
    });
    return;
  }

  if (type === 'run') {
    const chatKey = String(message?.chat_key ?? '').trim();
    const text = String(message?.text ?? '').trim();
    const workdir = normalizeRequestedWorkdir(message?.workdir);

    if (!chatKey || !text) {
      await postEvent({
        type: 'error',
        request_id: requestId,
        error: 'chat_key and text are required',
      });
      return;
    }

    void queueManager.enqueue(
      chatKey,
      () =>
        postEvent({
          type: 'progress',
          request_id: requestId,
          text: 'Previous request is still running. Your message has been queued.',
        }),
      async () => {
        await postEvent({
          type: 'accepted',
          request_id: requestId,
          chat_key: chatKey,
          workdir,
        });
        await runCodexCommand({
          requestId,
          chatKey,
          text,
          workdir,
          metadata: message?.metadata,
        });
      },
    );
    return;
  }

  await postEvent({
    type: 'error',
    request_id: requestId,
    error: `unsupported command type "${type}"`,
  });
}

async function runCodexCommand({ requestId, chatKey, text, workdir, metadata }) {
  const state = await stateStore.read(chatKey);
  const userTurn = {
    role: 'user',
    text,
    ts: new Date().toISOString(),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };

  const progress = createProgressReporter(requestId);
  let finalText;
  let result;

  try {
    result = await codexRuntime.runCodex(
      codexRuntime.buildPrompt({
        bridgeLabel: 'remote',
        messageText: text,
        extraContext: [
          `Remote server id: ${REMOTE_SERVER_ID}`,
          `Remote chat key: ${chatKey}`,
        ],
        maxPromptChars: MAX_PROMPT_CHARS,
        workdir,
      }),
      [],
      state.sessionId,
      progress,
      { workdir },
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

  await postEvent({
    type: 'final',
    request_id: requestId,
    chat_key: chatKey,
    final_text: finalText,
    session_id: state.sessionId,
    turn_count: state.turnCount,
    workdir,
  });
}

function createProgressReporter(requestId) {
  let lastSentAt = 0;
  let latestText = null;
  let timer = null;

  const flush = async force => {
    if (!latestText) return;
    if (!force && Date.now() - lastSentAt < REMOTE_PROGRESS_UPDATE_MS) return;
    const text = latestText;
    latestText = null;
    lastSentAt = Date.now();
    await postEvent({ type: 'progress', request_id: requestId, text });
  };

  return {
    async update(text) {
      latestText = text;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush(false);
        }, REMOTE_PROGRESS_UPDATE_MS);
      }
    },
    async note(text) {
      latestText = text;
      await flush(true);
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush(true);
    },
  };
}

async function renderStatusText(chatKey) {
  const state = await stateStore.read(chatKey);
  return [
    `server_id: ${REMOTE_SERVER_ID}`,
    `chat_key: ${chatKey}`,
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

async function postEvent(payload) {
  const response = await fetch(`${REMOTE_CLIENT_URL}${REMOTE_EVENT_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...buildAuthHeaders({
        serverId: REMOTE_SERVER_ID,
        sharedSecret: REMOTE_SHARED_SECRET,
      }),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`event upload failed with HTTP ${response.status}: ${detail || response.statusText}`);
  }
}

function normalizePath(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function normalizeRequestedWorkdir(value) {
  const requested = String(value ?? '').trim();
  return requested || CODEX_WORKDIR;
}

async function ensureStateDirs() {
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([
    mkdir(STATE_DIR, { recursive: true }),
    mkdir(CHAT_DIR, { recursive: true }),
    mkdir(RUN_DIR, { recursive: true }),
  ]);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function registerShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shutdownRequested = true;
    });
  }
}
