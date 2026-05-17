// =============================================================================
// Mini-Markdown-Renderer für KB-Artikel
//
// Bewusst minimal — kein Library-Overhead. Unterstützt:
// - # ## ### Headings
// - **bold**, *italic*, `code`
// - - / * unordered lists
// - 1. ordered lists
// - > blockquote
// - ```code blocks```
// - [link](url)
// - paragraphs
//
// HTML-Escape für jeden Text-Block — keine XSS-Lücke. Nur die definierten
// Markdown-Tokens werden zu HTML-Tags. Keine HTML-Passthrough.
// =============================================================================

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  let out = esc(s);
  // Code first (so its contents don't get further processed)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text: string, url: string) => {
      // nur http(s) und mailto erlauben
      const safe = /^(https?:|mailto:|\/)/i.test(url) ? url : '#';
      return `<a href="${esc(safe)}">${text}</a>`;
    },
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
      blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
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
      if (cur.startsWith('```') || /^#{1,6}\s/.test(cur) || cur.startsWith('> ') || /^[-*]\s/.test(cur) || /^\d+\.\s/.test(cur)) {
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
