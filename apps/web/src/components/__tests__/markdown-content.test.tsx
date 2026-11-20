// MarkdownContent: einzige Markdown-Einfügestelle (SAST-Befund XSS). Die
// Komponente nimmt Quelltext an und fügt exakt die escapete Ausgabe von
// renderMarkdown ein; Aufrufer können kein fertiges HTML durchreichen.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/lib/markdown';
import { MarkdownContent } from '../markdown-content';

const QUELLE = [
  '# Umfang <script>alert(1)</script>',
  '',
  '<img src=x onerror=alert(1)> und [Link](javascript:alert(1))',
  '',
  '- **Steuer**erklärung',
].join('\n');

describe('MarkdownContent', () => {
  it('fügt nur die escapete Renderer-Ausgabe ein', () => {
    const html = renderToStaticMarkup(<MarkdownContent className="prose" source={QUELLE} />);
    expect(html).toBe(`<div class="prose">${renderMarkdown(QUELLE)}</div>`);
    expect(html).not.toMatch(/<script|<img|javascript:/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<a href="#">Link</a>');
  });

  it('rendert als article, wenn verlangt', () => {
    expect(renderToStaticMarkup(<MarkdownContent as="article" source="Text" />)).toBe(
      '<article><p>Text</p></article>',
    );
  });
});
