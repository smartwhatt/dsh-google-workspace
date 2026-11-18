/**
 * Minimal Markdown → Google Docs batchUpdate renderer.
 *
 * Supports headings (#..######), bullet and numbered lists, code fences,
 * block quotes, bold / italic / inline-code / links. That covers what an
 * agent produces; anything else degrades to a plain paragraph.
 */

const INLINE_RULES = [
  { re: /\*\*([^*]+)\*\*/, style: 'bold' },
  { re: /__([^_]+)__/, style: 'bold' },
  { re: /(?<![*\w])\*([^*\n]+)\*(?![*\w])/, style: 'italic' },
  { re: /(?<![_\w])_([^_\n]+)_(?![_\w])/, style: 'italic' },
  { re: /~~([^~]+)~~/, style: 'strikethrough' },
  { re: /`([^`]+)`/, style: 'code' },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, style: 'link' },
];

/** Strip inline markup, returning the plain text plus style ranges relative to it. */
function parseInline(line) {
  let out = '';
  const styles = [];
  let rest = line;

  while (rest.length > 0) {
    let best = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m && m.index !== undefined) {
        if (!best || m.index < best.index) best = { ...rule, match: m };
      }
    }
    if (!best) {
      out += rest;
      break;
    }
    out += rest.slice(0, best.match.index);
    const inner = best.match[1];
    const start = out.length;
    out += inner;
    const style = { ...best, start, end: out.length };
    if (best.style === 'link') style.url = best.match[2];
    styles.push(style);
    rest = rest.slice(best.match.index + best.match[0].length);
  }

  return { text: out, styles };
}

function headingStyle(level) {
  return `HEADING_${Math.min(level, 6)}`;
}

/**
 * @param {string} markdown
 * @returns {{ text: string, requests: object[] }} requests use indices starting at 0;
 *          the caller offsets them by the insertion index.
 */
export function markdownToDocRequests(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let text = '';
  const paragraphOps = [];
  const textOps = [];
  let inCode = false;
  let codeStart = -1;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      if (!inCode) {
        inCode = true;
        codeStart = text.length;
      } else {
        inCode = false;
        if (text.length > codeStart) {
          textOps.push({ style: 'code', start: codeStart, end: text.length - 1 });
        }
      }
      continue;
    }

    if (inCode) {
      text += `${rawLine}\n`;
      continue;
    }

    if (line.trim() === '') {
      if (text.length > 0 && !text.endsWith('\n\n')) text += '\n';
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) continue;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    let content = line;
    let kind = 'paragraph';

    if (heading) {
      content = heading[2];
      kind = `heading${heading[1].length}`;
    } else if (bullet) {
      content = bullet[2];
      kind = 'bullet';
    } else if (numbered) {
      content = numbered[2];
      kind = 'numbered';
    } else if (quote) {
      content = quote[1];
      kind = 'quote';
    }

    const start = text.length;
    const parsed = parseInline(content);
    text += `${parsed.text}\n`;
    const end = text.length;

    for (const style of parsed.styles) {
      textOps.push({ ...style, start: start + style.start, end: start + style.end });
    }

    if (kind !== 'paragraph' && kind !== 'quote') {
      paragraphOps.push({ kind, start, end });
    }
  }

  const requests = [];
  if (text.length > 0) {
    requests.push({ insertText: { location: { index: 0 }, text } });
  }

  // Merge consecutive list items into one bullet range so numbering stays continuous.
  const listRanges = [];
  for (const op of paragraphOps) {
    const previous = listRanges[listRanges.length - 1];
    if (previous && previous.kind === op.kind && previous.end === op.start) {
      previous.end = op.end;
    } else {
      listRanges.push({ ...op });
    }
  }

  for (const op of listRanges) {
    const range = { startIndex: op.start, endIndex: op.end };
    if (op.kind.startsWith('heading')) {
      const level = Number(op.kind.replace('heading', ''));
      requests.push({
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: headingStyle(level) },
          fields: 'namedStyleType',
        },
      });
    } else if (op.kind === 'bullet') {
      requests.push({
        createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
      });
    } else if (op.kind === 'numbered') {
      requests.push({
        createParagraphBullets: { range, bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' },
      });
    }
  }

  for (const op of textOps) {
    const range = { startIndex: op.start, endIndex: op.end };
    if (op.style === 'bold') {
      requests.push({ updateTextStyle: { range, textStyle: { bold: true }, fields: 'bold' } });
    } else if (op.style === 'italic') {
      requests.push({ updateTextStyle: { range, textStyle: { italic: true }, fields: 'italic' } });
    } else if (op.style === 'strikethrough') {
      requests.push({
        updateTextStyle: { range, textStyle: { strikethrough: true }, fields: 'strikethrough' },
      });
    } else if (op.style === 'code') {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: {
            weightedFontFamily: { fontFamily: 'Roboto Mono', weight: 400 },
            backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
          },
          fields: 'weightedFontFamily,backgroundColor',
        },
      });
    } else if (op.style === 'link') {
      requests.push({
        updateTextStyle: { range, textStyle: { link: { url: op.url } }, fields: 'link' },
      });
    }
  }

  return { text, requests };
}

/** Shift zero-based request indices so they apply at `offset` in the document. */
export function shiftRequests(requests, offset) {
  if (!offset) return requests;
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'startIndex' || key === 'endIndex' || key === 'index') {
        if (typeof child === 'number') value[key] = child + offset;
      } else {
        walk(child);
      }
    }
  };
  const clones = structuredClone(requests);
  walk(clones);
  return clones;
}
