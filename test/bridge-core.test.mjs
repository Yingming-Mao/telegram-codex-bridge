import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexArgs,
  formatTelegramStartupError,
  splitText,
} from '../bridge-core.mjs';

const BASE_CONFIG = {
  approvalMode: 'never',
  bypassApprovalsAndSandbox: false,
  model: 'gpt-5.4',
  profile: 'default',
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
  stateDir: '/tmp/telegram-codex-state',
  workdir: '/workspace/project',
};

test('buildCodexArgs adds --add-dir on first exec', () => {
  const args = buildCodexArgs({
    sessionId: null,
    imagePaths: ['/tmp/telegram-codex-state/inbox/photo.png'],
    outputPath: '/tmp/out.txt',
    config: BASE_CONFIG,
  });

  assert.deepEqual(args, [
    '-a',
    'never',
    '-s',
    'workspace-write',
    'exec',
    '-C',
    '/workspace/project',
    '--json',
    '--color',
    'never',
    '--add-dir',
    '/tmp/telegram-codex-state',
    '-m',
    'gpt-5.4',
    '-p',
    'default',
    '--skip-git-repo-check',
    '-i',
    '/tmp/telegram-codex-state/inbox/photo.png',
    '-o',
    '/tmp/out.txt',
    '-',
  ]);
});

test('buildCodexArgs uses dangerous bypass flag when requested', () => {
  const args = buildCodexArgs({
    sessionId: null,
    imagePaths: [],
    outputPath: '/tmp/out.txt',
    config: {
      ...BASE_CONFIG,
      bypassApprovalsAndSandbox: true,
    },
  });

  assert.deepEqual(args, [
    '--dangerously-bypass-approvals-and-sandbox',
    'exec',
    '-C',
    '/workspace/project',
    '--json',
    '--color',
    'never',
    '--add-dir',
    '/tmp/telegram-codex-state',
    '-m',
    'gpt-5.4',
    '-p',
    'default',
    '--skip-git-repo-check',
    '-o',
    '/tmp/out.txt',
    '-',
  ]);
});

test('buildCodexArgs carries writable roots through resume config override', () => {
  const args = buildCodexArgs({
    sessionId: 'thread-123',
    imagePaths: ['/tmp/telegram-codex-state/inbox/photo.png'],
    outputPath: '/tmp/out.txt',
    config: BASE_CONFIG,
  });

  assert.deepEqual(args, [
    '-a',
    'never',
    '-s',
    'workspace-write',
    'exec',
    'resume',
    '-c',
    'sandbox_workspace_write.writable_roots=["/tmp/telegram-codex-state"]',
    '-m',
    'gpt-5.4',
    '-p',
    'default',
    '--skip-git-repo-check',
    '-i',
    '/tmp/telegram-codex-state/inbox/photo.png',
    '--json',
    '-o',
    '/tmp/out.txt',
    'thread-123',
    '-',
  ]);
});

test('splitText prefers paragraph and line boundaries', () => {
  const chunks = splitText('alpha beta\n\ngamma delta\nepsilon zeta', 18);
  assert.deepEqual(chunks, ['alpha beta', 'gamma delta', 'epsilon zeta']);
});

test('formatTelegramStartupError highlights 409 conflicts', () => {
  const text = formatTelegramStartupError({
    err: new Error("Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request)"),
    apiRoot: 'https://api.telegram.org',
    proxyUrl: 'http://127.0.0.1:7890',
  });

  assert.match(text, /another bot instance is already polling this token/i);
  assert.match(text, /409 Conflict/);
});

test('formatTelegramStartupError explains proxy timeouts', () => {
  const err = new Error('connect ETIMEDOUT');
  err.code = 'ETIMEDOUT';

  const text = formatTelegramStartupError({
    err,
    apiRoot: 'https://api.telegram.org',
    proxyUrl: 'http://127.0.0.1:7890',
  });

  assert.match(text, /network_code: ETIMEDOUT/);
  assert.match(text, /through the configured proxy/);
});
