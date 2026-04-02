import { randomUUID, createHmac } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';

export function loadEnvFile(file) {
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

export function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeCodexApprovalMode(explicitValue, legacyFullAutoValue, logPrefix) {
  const explicit = explicitValue?.trim().toLowerCase();
  if (
    explicit === 'never' ||
    explicit === 'on-request' ||
    explicit === 'on-failure' ||
    explicit === 'untrusted'
  ) {
    return explicit;
  }
  if (explicit) {
    process.stderr.write(
      `${logPrefix}: unsupported CODEX_APPROVAL_MODE "${explicitValue}", falling back to compatibility mode.\n`,
    );
  }
  return parseBool(legacyFullAutoValue ?? '1') ? 'never' : 'on-request';
}

export function normalizeCodexSandboxMode(explicitValue, legacySandboxValue) {
  const value = (explicitValue ?? legacySandboxValue ?? 'workspace-write').trim();
  return value || 'workspace-write';
}

export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createJsonLineParser(onMessage) {
  let buffer = '';

  return chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      onMessage(parsed);
    }
  };
}

export function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function createRequestId(prefix = 'req') {
  return `${prefix}-${Date.now()}-${randomUUID()}`;
}

export function buildAuthHeaders({ serverId, sharedSecret }) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = signRemoteHeaders({ serverId, sharedSecret, timestamp, nonce });

  return {
    'x-codex-server-id': serverId,
    'x-codex-timestamp': timestamp,
    'x-codex-nonce': nonce,
    'x-codex-signature': signature,
  };
}

export function verifyRemoteHeaders({
  headers,
  expectedSharedSecret,
  maxSkewMs = 60_000,
}) {
  const serverId = String(headers['x-codex-server-id'] ?? '').trim();
  const timestamp = String(headers['x-codex-timestamp'] ?? '').trim();
  const nonce = String(headers['x-codex-nonce'] ?? '').trim();
  const signature = String(headers['x-codex-signature'] ?? '').trim();

  if (!serverId || !timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing auth headers' };
  }

  const parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs) || Math.abs(Date.now() - parsedTs) > maxSkewMs) {
    return { ok: false, reason: 'stale timestamp' };
  }

  const expected = signRemoteHeaders({
    serverId,
    sharedSecret: expectedSharedSecret,
    timestamp,
    nonce,
  });
  if (expected !== signature) {
    return { ok: false, reason: 'invalid signature' };
  }

  return { ok: true, serverId, timestamp, nonce };
}

function signRemoteHeaders({ serverId, sharedSecret, timestamp, nonce }) {
  return createHmac('sha256', sharedSecret)
    .update(`${serverId}\n${timestamp}\n${nonce}`)
    .digest('hex');
}
