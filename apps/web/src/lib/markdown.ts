// =============================================================================
// Mini-Markdown-Renderer für KB-Artikel
//
// Bewusst minimal — kein Library-Overhead. Unterstützt:
// - # ## ### Headings
// - **bold**, *italic*, ~~strike~~, `code`
// - - / * unordered lists
// - 1. ordered lists
// - > blockquote
// - ```code blocks```
// - [link](url)
// - ![alt](url) für intern hochgeladene Wissensbilder
// - | Tabellen | (GitHub-Stil, mit Separator-Zeile)
// - --- horizontale Trennlinie
// - paragraphs
//
// HTML-Escape für jeden Text-Block — keine XSS-Lücke. Nur die definierten
// Markdown-Tokens sowie eng begrenzte, vom Inline-Editor erzeugte
// Textstil-Spans werden zu HTML-Tags. Keine allgemeine HTML-Passthrough.
// =============================================================================

import { escapeHtml, safeHref } from './markdown-safety';

const KNOWLEDGE_IMAGE_SRC =
  /^\/api\/staff\/knowledge\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STYLE_COLOR = /^#[0-9a-f]{6}$/i;
const SAFE_STYLE_FONT_SIZE = /^(?:0\.875|1|1\.125|1\.25|1\.5)rem$/;

function safeImageSrc(url: string): string {
  const safe = safeHref(url);
  return KNOWLEDGE_IMAGE_SRC.test(safe) ? safe : '#';
}

function safeTextStyle(raw: string): string | null {
  const declarations: string[] = [];
  for (const declaration of raw.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if ((property === 'color' || property === 'background-color') && SAFE_STYLE_COLOR.test(value)) {
      declarations.push(`${property}: ${value}`);
    }
    if (property === 'font-size' && SAFE_STYLE_FONT_SIZE.test(value)) {
      declarations.push(`${property}: ${value}`);
    }
  }
  return declarations.length > 0 ? [...new Set(declarations)].join('; ') : null;
}

// Tokens werden aus dem Quelltext gelesen. Erzeugtes HTML wird nie erneut
// geparst; Code, Linkziele und Alt-Texte behalten dadurch ihren eigenen Kontext.
// Ein neuer Link-/Stilanfang beendet einen unvollständigen Vorgänger. Dadurch
// durchsuchen wiederholte Öffner nicht jeweils den gesamten restlichen Text.
const INLINE_LINK_TARGET = /(?:(?!!?\[[^[\]]*\]\()[^)])+/.source;
const INLINE_TOKEN = new RegExp(
  [
    /`(?<code>[^`]+)`/.source,
    /<span\s+style=(?<quote>['"])(?<style>[^'"]*)\k<quote>>(?<span>(?:(?!<span\b).)*?)<\/span>/
      .source,
    /<u>(?<underline>(?:(?!<u>).)*?)<\/u>/.source,
    String.raw`!\[(?<alt>[^\[\]]*)\]\((?<imageUrl>${INLINE_LINK_TARGET})\)`,
    String.raw`\[(?<label>[^\[\]]+)\]\((?<linkUrl>${INLINE_LINK_TARGET})\)`,
    /~~(?<strike>(?:`[^`]+`|[^~`])+)~~/.source,
    /\*\*(?<bold>(?:`[^`]+`|[^*`])+)\*\*/.source,
    /\*(?<italic>(?:`[^`]+`|[^*`])+)\*/.source,
  ].join('|'),
  'gi',
);

function renderInlineToken(token: Record<string, string | undefined>): string {
  if (token.code !== undefined) return `<code>${escapeHtml(token.code)}</code>`;
  if (token.span !== undefined) {
    const style = safeTextStyle(token.style!);
    const content = inline(token.span);
    return style ? `<span style="${style}">${content}</span>` : content;
  }
  if (token.underline !== undefined) return `<u>${inline(token.underline)}</u>`;
  if (token.alt !== undefined) {
    return `<img src="${safeImageSrc(token.imageUrl!)}" alt="${escapeHtml(token.alt)}" loading="lazy">`;
  }
  if (token.label !== undefined) {
    return `<a href="${escapeHtml(safeHref(token.linkUrl!))}">${inline(token.label)}</a>`;
  }
  if (token.strike !== undefined) return `<s>${inline(token.strike)}</s>`;
  if (token.bold !== undefined) return `<strong>${inline(token.bold)}</strong>`;
  return `<em>${inline(token.italic!)}</em>`;
}

function inline(source: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE_TOKEN)) {
    parts.push(escapeHtml(source.slice(cursor, match.index)), renderInlineToken(match.groups!));
    cursor = match.index + match[0].length;
  }
  parts.push(escapeHtml(source.slice(cursor)));
  return parts.join('');
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST = /^[-*]\s+/;
const ORDERED_LIST = /^\d+\.\s+/;

type BlockKind =
  | 'code'
  | 'heading'
  | 'hr'
  | 'table'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'blank'
  | 'paragraph';
type RenderedBlock = { html: string; next: number };

// Dieselbe Erkennung steuert Blockauswahl und Absatzende. Ein einzelnes "|"
// ohne Tabellentrenner bleibt normaler Text und kann den Cursor nicht festhalten.
function blockKind(lines: string[], index: number): BlockKind {
  const line = lines[index] ?? '';
  if (line.startsWith('```')) return 'code';
  if (HEADING.test(line)) return 'heading';
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return 'hr';
  const separator = (lines[index + 1] ?? '').trim();
  if (line.trimStart().startsWith('|') && /^[\s:|-]+$/.test(separator) && separator.includes('-'))
    return 'table';
  if (line.startsWith('> ')) return 'quote';
  if (UNORDERED_LIST.test(line)) return 'ul';
  if (ORDERED_LIST.test(line)) return 'ol';
  return line.trim() === '' ? 'blank' : 'paragraph';
}

function collectLines(
  lines: string[],
  start: number,
  accepts: (line: string, index: number) => boolean,
) {
  let next = start;
  while (next < lines.length && accepts(lines[next]!, next)) next++;
  return { content: lines.slice(start, next), next };
}

function tableRow(row: string, tag: 'th' | 'td'): string {
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return `<tr>${cells.map((cell) => `<${tag}>${inline(cell.trim())}</${tag}>`).join('')}</tr>`;
}

function renderTable(lines: string[], start: number): RenderedBlock {
  const rows = collectLines(lines, start + 2, (line) => line.trimStart().startsWith('|'));
  const head = `<thead>${tableRow(lines[start]!, 'th')}</thead>`;
  const body = `<tbody>${rows.content.map((row) => tableRow(row, 'td')).join('')}</tbody>`;
  return { html: `<table>${head}${body}</table>`, next: rows.next };
}

function renderList(lines: string[], start: number, tag: 'ul' | 'ol'): RenderedBlock {
  const marker = tag === 'ul' ? UNORDERED_LIST : ORDERED_LIST;
  const items = collectLines(lines, start, (line) => marker.test(line));
  const html = items.content.map((line) => `<li>${inline(line.replace(marker, ''))}</li>`).join('');
  return { html: `<${tag}>${html}</${tag}>`, next: items.next };
}

function renderBlock(lines: string[], start: number): RenderedBlock {
  const kind = blockKind(lines, start);
  switch (kind) {
    case 'blank':
      return { html: '', next: start + 1 };
    case 'hr':
      return { html: '<hr>', next: start + 1 };
    case 'heading': {
      const heading = HEADING.exec(lines[start]!)!;
      const level = heading[1]!.length;
      return { html: `<h${level}>${inline(heading[2]!)}</h${level}>`, next: start + 1 };
    }
    case 'code': {
      const code = collectLines(lines, start + 1, (line) => !line.startsWith('```'));
      return {
        html: `<pre><code>${escapeHtml(code.content.join('\n'))}</code></pre>`,
        next: code.next + 1,
      };
    }
    case 'table':
      return renderTable(lines, start);
    case 'ul':
    case 'ol':
      return renderList(lines, start, kind);
    case 'quote': {
      const quote = collectLines(lines, start, (line) => line.startsWith('> '));
      const text = quote.content.map((line) => line.slice(2)).join(' ');
      return { html: `<blockquote>${inline(text)}</blockquote>`, next: quote.next };
    }
    case 'paragraph': {
      const paragraph = collectLines(
        lines,
        start,
        (_line, index) => blockKind(lines, index) === 'paragraph',
      );
      return { html: `<p>${inline(paragraph.content.join(' '))}</p>`, next: paragraph.next };
    }
  }
}

export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const block = renderBlock(lines, cursor);
    if (block.html) blocks.push(block.html);
    cursor = block.next;
  }
  return blocks.join('\n');
}
