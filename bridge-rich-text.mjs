function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function applyInlineMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
      return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    })
    .replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold) => `<b>${escapeHtml(bold)}</b>`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_match, prefix, italic) => {
      return `${prefix}<i>${escapeHtml(italic)}</i>`;
    });
}

export function renderTelegramHtml(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const parts = [];
  const fencePattern = /```([\w+-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderTelegramTextBlock(source.slice(lastIndex, match.index)));
    }

    const language = match[1]?.trim();
    const code = escapeHtml(match[2].replace(/\n$/, ''));
    if (language) {
      parts.push(`<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>`);
    } else {
      parts.push(`<pre>${code}</pre>`);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    parts.push(renderTelegramTextBlock(source.slice(lastIndex)));
  }

  return parts.filter(Boolean).join('\n');
}

function renderTelegramTextBlock(text) {
  if (!text.trim()) return '';

  return text
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('# ')) return `<b>${escapeHtml(trimmed.slice(2))}</b>`;
      if (trimmed.startsWith('## ')) return `<b>${escapeHtml(trimmed.slice(3))}</b>`;
      return applyInlineMarkdown(escapeHtmlExceptMarkdown(line));
    })
    .join('\n');
}

function escapeHtmlExceptMarkdown(line) {
  const placeholders = [];
  const protectedLine = line.replace(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|(^|[\s(])\*[^*\n]+\*(?=[\s).,!?:;]|$))/g, match => {
    const key = `__PLACEHOLDER_${placeholders.length}__`;
    placeholders.push(match);
    return key;
  });

  let escaped = escapeHtml(protectedLine);
  placeholders.forEach((value, index) => {
    escaped = escaped.replace(`__PLACEHOLDER_${index}__`, value);
  });
  return escaped;
}

export function buildFeishuPostMessage(text) {
  return {
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text: String(text ?? '') || '(empty response)',
          },
        ],
      ],
    },
  };
}

export function buildFeishuMarkdownCard(text) {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: String(text ?? '') || '(empty response)',
        },
      ],
    },
  };
}

export function shouldUseFeishuCard(text) {
  const source = String(text ?? '');
  return /```[\s\S]*?```/.test(source) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(source);
}
