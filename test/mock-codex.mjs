#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);

let outputPath = null;
let sessionId = null;
let isResume = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-o' && i + 1 < args.length) {
    outputPath = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === 'resume') {
    isResume = true;
    continue;
  }
}

if (isResume) {
  const outputIndex = args.findIndex(arg => arg === '-o');
  if (outputIndex >= 0 && outputIndex + 2 < args.length) {
    sessionId = args[outputIndex + 2];
  }
}

const prompt = await readStdin();
const threadId = sessionId || `mock-thread-${randomUUID()}`;
const finalText = isResume
  ? `mock-codex resume ok\nthread=${threadId}\nprompt=${preview(prompt)}`
  : `mock-codex start ok\nthread=${threadId}\nprompt=${preview(prompt)}`;

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
process.stdout.write(
  `${JSON.stringify({ type: 'turn.started' })}\n`,
);
process.stdout.write(
    `${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: `working on: ${preview(prompt)}` },
    })}\n`,
);

if (outputPath) {
  await writeFile(outputPath, `${finalText}\n`);
}

function preview(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}
