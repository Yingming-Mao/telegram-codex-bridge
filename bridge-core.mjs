function buildWritableRootsOverride(writableRoots) {
  return `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`;
}

export function buildCodexArgs({ sessionId, imagePaths, outputPath, config }) {
  const args = [];

  if (config.approvalMode) args.push('-a', config.approvalMode);
  if (config.sandboxMode) args.push('-s', config.sandboxMode);
  args.push('exec');

  if (sessionId) {
    args.push('resume');

    // `codex exec resume` does not expose `--add-dir`, so carry the writable
    // roots through a config override instead.
    if (config.stateDir) {
      args.push('-c', buildWritableRootsOverride([config.stateDir]));
    }

    if (config.model) args.push('-m', config.model);
    if (config.profile) args.push('-p', config.profile);
    if (config.skipGitRepoCheck) args.push('--skip-git-repo-check');
    for (const imagePath of imagePaths) {
      args.push('-i', imagePath);
    }
    args.push('--json', '-o', outputPath, sessionId, '-');
    return args;
  }

  args.push(
    '-C',
    config.workdir,
    '--json',
    '--color',
    'never',
    '--add-dir',
    config.stateDir,
  );

  if (config.model) args.push('-m', config.model);
  if (config.profile) args.push('-p', config.profile);
  if (config.skipGitRepoCheck) args.push('--skip-git-repo-check');
  for (const imagePath of imagePaths) {
    args.push('-i', imagePath);
  }
  args.push('-o', outputPath, '-');
  return args;
}

export function splitText(text, limit) {
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

export function keepTail(text, maxLength) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

export function redactUrlAuth(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

export function formatTelegramStartupError({ err, apiRoot, proxyUrl }) {
  const networkError = err?.error ?? err?.cause ?? err;
  const code = networkError?.code ?? 'UNKNOWN';
  const fullMessage = [err?.message, networkError?.message].filter(Boolean).join(' | ');

  if (/\(409:\s*Conflict:/i.test(fullMessage)) {
    return [
      'telegram-codex-bridge: another bot instance is already polling this token.',
      `api_root: ${apiRoot}`,
      `proxy: ${proxyUrl ? redactUrlAuth(proxyUrl) : '(none)'}`,
      'detail: Telegram returned 409 Conflict for getUpdates.',
      'Only one process can use long polling for the same bot token at a time.',
      'Stop the other running bot instance, or create a new bot token with @BotFather and update TELEGRAM_BOT_TOKEN.',
      'If you saw a different reply style in Telegram before, that other instance was likely handling your messages.',
    ].join('\n');
  }

  const lines = [
    'telegram-codex-bridge: failed to reach Telegram Bot API.',
    `api_root: ${apiRoot}`,
    `proxy: ${proxyUrl ? redactUrlAuth(proxyUrl) : '(none)'}`,
    `network_code: ${code}`,
    `detail: ${networkError?.message ?? String(networkError)}`,
  ];

  if (code === 'ECONNREFUSED' && proxyUrl) {
    lines.push('The configured proxy refused the connection. Make sure the local proxy process is running.');
  } else if (['ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET'].includes(code)) {
    lines.push(
      proxyUrl
        ? 'Telegram is still unreachable through the configured proxy.'
        : 'Telegram is unreachable directly from this machine. Set TELEGRAM_PROXY_URL or TELEGRAM_API_ROOT to a reachable endpoint.',
    );
  }

  if (err?.message && err.message !== networkError?.message) {
    lines.push(`api_error: ${err.message}`);
  }

  return lines.join('\n');
}
