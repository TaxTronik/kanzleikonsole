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

function inline(s: string): string {
  const preserved: string[] = [];
  const preserve = (html: string): string => {
    const token = `\uE000${preserved.length}\uE001`;
    preserved.push(html);
    return token;
  };
  let source = s.replace(
    /<span\s+style=(['"])([^'"]*)\1>(.*?)<\/span>/gi,
    (_match, _quote: string, style: string, content: string) => {
      const safeStyle = safeTextStyle(style);
      return safeStyle ? preserve(`<span style="${safeStyle}">${inline(content)}</span>`) : content;
    },
  );
  source = source.replace(/<u>(.*?)<\/u>/gi, (_match, content: string) => {
    return preserve(`<u>${inline(content)}</u>`);
  });

  let out = escapeHtml(source);
  // Code first (so its contents don't get further processed)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Durchgestrichen
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Bilder ausschließlich aus dem authentifizierten Wissens-Anhangspfad.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
    return `<img src="${safeImageSrc(url)}" alt="${alt}" loading="lazy">`;
  });
  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${safeHref(url)}">${text}</a>`;
  });
  out = out.replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => preserved[Number(index)] ?? '',
  );
  return out;
}

export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Code block
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // closing ```
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1]!.length;
      blocks.push(`<h${lvl}>${inline(h[2]!)}</h${lvl}>`);
      i++;
      continue;
    }

    // Horizontale Trennlinie
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }

    // Tabelle (GitHub-Stil): Kopfzeile + Separator-Zeile aus |---|---|
    if (
      line.trimStart().startsWith('|') &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') &&
      (lines[i + 1] ?? '').includes('-')
    ) {
      const splitRow = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const header = splitRow(line);
      i += 2; // Kopf + Separator
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
        rows.push(splitRow(lines[i] ?? ''));
        i++;
      }
      const thead = `<thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        quote.push((lines[i] ?? '').slice(2));
        i++;
      }
      blocks.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Empty line — paragraph break
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (collect contiguous non-empty lines)
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const cur = lines[i] ?? '';
      // Stop if we hit another block element
      if (
        cur.startsWith('```') ||
        /^#{1,6}\s/.test(cur) ||
        cur.startsWith('> ') ||
        /^[-*]\s/.test(cur) ||
        /^\d+\.\s/.test(cur) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(cur) ||
        cur.trimStart().startsWith('|')
      ) {
        break;
      }
      para.push(cur);
      i++;
    }
    if (para.length > 0) {
      blocks.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }

  return blocks.join('\n');
}
