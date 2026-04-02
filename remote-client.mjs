#!/usr/bin/env node

import * as http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  createRequestId,
  loadEnvFile,
  positiveInt,
  readJsonBody,
  sendJson,
  verifyRemoteHeaders,
  writeJsonLine,
} from './remote-common.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(__filename);

loadEnvFile(join(PROJECT_ROOT, '.env'));

const STATE_DIR = process.env.BRIDGE_REMOTE_CLIENT_STATE_DIR ?? join(homedir(), '.codex-remote-client');
loadEnvFile(join(STATE_DIR, '.env'));

const CLIENT_HOST = process.env.REMOTE_CLIENT_HOST ?? '0.0.0.0';
const CLIENT_PORT = positiveInt(process.env.REMOTE_CLIENT_PORT, 8789);
const REMOTE_AGENT_PATH = normalizePath(process.env.REMOTE_AGENT_PATH ?? '/remote/agent/connect');
const REMOTE_EVENT_PATH = normalizePath(process.env.REMOTE_EVENT_PATH ?? '/remote/agent/events');
const REMOTE_API_PREFIX = normalizePath(process.env.REMOTE_API_PREFIX ?? '/remote/api');
const REMOTE_SHARED_SECRET = process.env.REMOTE_SHARED_SECRET?.trim() || null;
const REMOTE_CLIENT_API_TOKEN = process.env.REMOTE_CLIENT_API_TOKEN?.trim() || null;
const REMOTE_REQUEST_TIMEOUT_MS = positiveInt(process.env.REMOTE_REQUEST_TIMEOUT_MS, 900000);

if (!REMOTE_SHARED_SECRET) {
  process.stderr.write('remote-client: REMOTE_SHARED_SECRET is required.\n');
  process.exit(1);
}
if (!REMOTE_CLIENT_API_TOKEN) {
  process.stderr.write('remote-client: REMOTE_CLIENT_API_TOKEN is required.\n');
  process.exit(1);
}

const agents = new Map();
const pendingRequests = new Map();
let shutdownRequested = false;
let server = null;

registerShutdownHandlers();

server = http.createServer((req, res) => {
  void routeRequest(req, res).catch(err => {
    process.stderr.write(`remote-client: request failed: ${err?.stack ?? err}\n`);
    if (!res.headersSent) {
      sendJson(res, err?.statusCode ?? 500, {
        code: err?.statusCode ?? 500,
        msg: err?.message ?? 'internal error',
      });
    } else {
      res.end();
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(CLIENT_PORT, CLIENT_HOST, () => {
    server.off('error', reject);
    resolve();
  });
});

process.stderr.write(`remote-client: listening on http://${CLIENT_HOST}:${CLIENT_PORT}\n`);
process.stderr.write(`remote-client: agent_path ${REMOTE_AGENT_PATH}\n`);
process.stderr.write(`remote-client: event_path ${REMOTE_EVENT_PATH}\n`);
process.stderr.write(`remote-client: api_prefix ${REMOTE_API_PREFIX}\n`);

async function routeRequest(req, res) {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true, agents: agents.size });
    return;
  }

  if (req.method === 'GET' && pathname === REMOTE_AGENT_PATH) {
    await handleAgentConnect(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === REMOTE_EVENT_PATH) {
    await handleAgentEvent(req, res);
    return;
  }

  if (pathname === `${REMOTE_API_PREFIX}/servers` && req.method === 'GET') {
    requireApiToken(req);
    sendJson(res, 200, {
      servers: [...agents.values()].map(agent => ({
        server_id: agent.serverId,
        connected_at: agent.connectedAt,
        last_seen_at: agent.lastSeenAt,
        metadata: agent.metadata,
      })),
    });
    return;
  }

  if (pathname === `${REMOTE_API_PREFIX}/run` && req.method === 'POST') {
    requireApiToken(req);
    const body = await readJsonBody(req);
    const result = await dispatchAgentCommand({
      type: 'run',
      serverId: String(body.server_id ?? '').trim(),
      payload: {
        chat_key: String(body.chat_key ?? '').trim(),
        text: String(body.text ?? '').trim(),
        workdir: normalizeOptionalString(body.workdir),
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
      },
    });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === `${REMOTE_API_PREFIX}/status` && req.method === 'POST') {
    requireApiToken(req);
    const body = await readJsonBody(req);
    const result = await dispatchAgentCommand({
      type: 'status',
      serverId: String(body.server_id ?? '').trim(),
      payload: {
        chat_key: String(body.chat_key ?? '').trim(),
      },
    });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === `${REMOTE_API_PREFIX}/reset` && req.method === 'POST') {
    requireApiToken(req);
    const body = await readJsonBody(req);
    const result = await dispatchAgentCommand({
      type: 'reset',
      serverId: String(body.server_id ?? '').trim(),
      payload: {
        chat_key: String(body.chat_key ?? '').trim(),
      },
    });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { code: 404, msg: 'not found' });
}

async function handleAgentConnect(req, res) {
  const auth = verifyRemoteHeaders({
    headers: req.headers,
    expectedSharedSecret: REMOTE_SHARED_SECRET,
  });
  if (!auth.ok) {
    sendJson(res, 401, { code: 401, msg: auth.reason });
    return;
  }

  const serverId = auth.serverId;
  const metadata = {
    hostname: normalizeOptionalString(req.headers['x-codex-hostname']),
    version: normalizeOptionalString(req.headers['x-codex-agent-version']),
    workdir: normalizeOptionalString(req.headers['x-codex-workdir']),
  };

  const existing = agents.get(serverId);
  if (existing?.stream && !existing.stream.destroyed) {
    existing.stream.end();
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  const agent = {
    serverId,
    stream: res,
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    metadata,
  };
  agents.set(serverId, agent);

  writeJsonLine(res, { type: 'hello_ack', server_id: serverId, ts: new Date().toISOString() });

  const keepAlive = setInterval(() => {
    if (res.destroyed) return;
    writeJsonLine(res, { type: 'ping', ts: new Date().toISOString() });
  }, 20_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    const current = agents.get(serverId);
    if (current?.stream === res) {
      agents.delete(serverId);
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleAgentEvent(req, res) {
  const auth = verifyRemoteHeaders({
    headers: req.headers,
    expectedSharedSecret: REMOTE_SHARED_SECRET,
  });
  if (!auth.ok) {
    sendJson(res, 401, { code: 401, msg: auth.reason });
    return;
  }

  const serverId = auth.serverId;
  const body = await readJsonBody(req);
  const type = String(body?.type ?? '').trim();
  const requestId = String(body?.request_id ?? '').trim();

  const agent = agents.get(serverId);
  if (agent) {
    agent.lastSeenAt = new Date().toISOString();
  }

  if (!type) {
    sendJson(res, 400, { code: 400, msg: 'type is required' });
    return;
  }

  const pending = requestId ? pendingRequests.get(requestId) : null;
  if (type === 'progress') {
    if (pending) {
      pending.progress = String(body?.text ?? '');
      pending.agentSeenAt = new Date().toISOString();
    }
    sendJson(res, 202, { ok: true });
    return;
  }

  if (type === 'accepted') {
    if (pending) {
      pending.accepted = body;
      pending.agentSeenAt = new Date().toISOString();
    }
    sendJson(res, 202, { ok: true });
    return;
  }

  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve({
      ok: type !== 'error',
      type,
      server_id: serverId,
      request_id: requestId,
      result: body,
      latest_progress: pending.progress ?? null,
      accepted: pending.accepted ?? null,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 202, { ok: true, pending: false });
}

async function dispatchAgentCommand({ type, serverId, payload }) {
  if (!serverId) {
    throw createHttpError(400, 'server_id is required');
  }
  const agent = agents.get(serverId);
  if (!agent?.stream || agent.stream.destroyed) {
    throw createHttpError(503, `server ${serverId} is not connected`);
  }

  if ((type === 'run' || type === 'status' || type === 'reset') && !String(payload.chat_key ?? '').trim()) {
    throw createHttpError(400, 'chat_key is required');
  }
  if (type === 'run' && !String(payload.text ?? '').trim()) {
    throw createHttpError(400, 'text is required');
  }

  const requestId = createRequestId(type);
  const command = {
    type,
    request_id: requestId,
    ...payload,
  };

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`${type} request timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms`));
    }, REMOTE_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      progress: null,
      accepted: null,
    });

    try {
      writeJsonLine(agent.stream, command);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(err);
    }
  });
}

function requireApiToken(req) {
  const auth = String(req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== REMOTE_CLIENT_API_TOKEN) {
    throw createHttpError(401, 'unauthorized');
  }
}

function normalizePath(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeOptionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function registerShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  process.stderr.write(`remote-client: received ${signal}, stopping...\n`);

  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('remote-client is shutting down'));
  }
  pendingRequests.clear();

  for (const agent of agents.values()) {
    agent.stream.end();
  }
  agents.clear();

  if (server) {
    await new Promise(resolve => server.close(() => resolve()));
  }

  process.exit(0);
}
