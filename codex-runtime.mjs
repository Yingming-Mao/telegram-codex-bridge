import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCodexArgs, keepTail } from './bridge-core.mjs';

export function createChatStateStore(chatDir) {
  return {
    async read(chatKey) {
      const path = join(chatDir, `${safeStateFileName(chatKey)}.json`);
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
    },

    async write(chatKey, state) {
      const path = join(chatDir, `${safeStateFileName(chatKey)}.json`);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    },

    async reset(chatKey) {
      const state = await this.read(chatKey);
      state.sessionId = null;
      state.turnCount = 0;
      state.history = [];
      await this.write(chatKey, state);
    },
  };
}

export function createChatQueueManager({ logPrefix }) {
  const chatQueues = new Map();

  return {
    async enqueue(chatKey, onBusy, fn) {
      const wasBusy = chatQueues.has(chatKey);
      if (wasBusy) {
        await onBusy();
      }

      const previous = chatQueues.get(chatKey) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(fn)
        .catch(err => {
          process.stderr.write(`${logPrefix}: chat ${chatKey} failed: ${err?.stack ?? err}\n`);
        })
        .finally(() => {
          if (chatQueues.get(chatKey) === next) {
            chatQueues.delete(chatKey);
          }
        });

      chatQueues.set(chatKey, next);
      await next;
    },
  };
}

export function createCodexRuntime(config) {
  return {
    async runCodex(prompt, imagePaths, sessionId, progress = createNullProgress()) {
      const outputPath = join(config.runDir, `${Date.now()}-${randomUUID()}.txt`);
      const args = buildCodexArgs({
        sessionId,
        imagePaths,
        outputPath,
        config: {
          approvalMode: config.approvalMode,
          bypassApprovalsAndSandbox: config.bypassApprovalsAndSandbox,
          model: config.model,
          profile: config.profile,
          sandboxMode: config.sandboxMode,
          skipGitRepoCheck: config.skipGitRepoCheck,
          stateDir: config.stateDir,
          workdir: config.workdir,
        },
      });

      return await new Promise((resolve, reject) => {
        const child = spawn(config.bin, args, {
          cwd: config.workdir,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let rawStdout = '';
        let stdoutBuffer = '';
        let stderr = '';
        let threadId = sessionId ?? null;
        let streamedText = '';
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
            const streamUpdate = extractStreamUpdate(event, streamedText);
            if (streamUpdate.fullText !== streamedText) {
              streamedText = streamUpdate.fullText;
              void progress.update(streamedText);
            } else if (streamUpdate.statusText) {
              void progress.note(streamUpdate.statusText);
            }
            if (
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              typeof event.item.text === 'string'
            ) {
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
            if (event) {
              const streamUpdate = extractStreamUpdate(event, streamedText);
              if (streamUpdate.fullText !== streamedText) {
                streamedText = streamUpdate.fullText;
                await progress.update(streamedText);
              } else if (streamUpdate.statusText) {
                await progress.note(streamUpdate.statusText);
              }
            }
            if (
              event?.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              typeof event.item.text === 'string'
            ) {
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
    },

    renderResult(result, maxOutputChars) {
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

      if (text.length > maxOutputChars) {
        text = `${text.slice(0, maxOutputChars)}\n\n[truncated]`;
      }

      return text;
    },

    buildPrompt({
      bridgeLabel,
      messageText,
      attachments = [],
      extraContext = [],
      maxPromptChars,
    }) {
      const latestAttachments = attachments.length
        ? attachments.map(att => `- ${att.kind}: ${att.path}`).join('\n')
        : 'None';
      const prefix = [
        `You are Codex CLI replying to a ${bridgeLabel} user through an automated bridge.`,
        'Treat the latest bridge message as the direct user request.',
        'Reply in plain text that reads well in chat.',
        'Keep the answer concise unless the user explicitly asks for detail.',
        `Your working directory is: ${config.workdir}`,
        `Bridge state directory is: ${config.stateDir}`,
        'This chat reuses the same Codex session across turns until /reset is sent.',
        'If the latest message references a saved local file, inspect that path directly when needed.',
        ...extraContext.filter(Boolean),
        '',
        'Latest message attachments:',
        latestAttachments,
        '',
        'Latest user message:',
      ].join('\n');

      const latestMessage = messageText?.trim() || '(empty message)';
      const budget = Math.max(1000, maxPromptChars - prefix.length);
      return `${prefix}\n${
        latestMessage.length > budget ? `${latestMessage.slice(0, budget)}\n\n[truncated]` : latestMessage
      }`;
    },
  };
}

function safeStateFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function createNullProgress() {
  return {
    async update() {},
    async note() {},
  };
}

function extractStreamUpdate(event, currentText) {
  if (!event || typeof event !== 'object') {
    return { fullText: currentText, statusText: null };
  }

  if (event.type === 'turn.started') {
    return { fullText: currentText, statusText: 'Thinking...' };
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    return { fullText: currentText, statusText: event.message };
  }
  if (
    event.type === 'item.completed' &&
    event.item?.type === 'error' &&
    typeof event.item.message === 'string'
  ) {
    return { fullText: currentText, statusText: event.item.message };
  }

  const fullTextCandidates = [
    event.item?.text,
    event.text,
    event.message?.text,
    event.output_text,
    event.delta?.snapshot,
    event.item?.delta?.snapshot,
  ];
  for (const candidate of fullTextCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return { fullText: candidate, statusText: null };
    }
  }

  const deltaCandidates = [
    event.delta,
    event.text_delta,
    event.delta?.text,
    event.item?.delta,
    event.item?.delta?.text,
  ];
  for (const candidate of deltaCandidates) {
    if (typeof candidate === 'string' && candidate) {
      return { fullText: `${currentText}${candidate}`, statusText: null };
    }
  }

  return { fullText: currentText, statusText: null };
}
