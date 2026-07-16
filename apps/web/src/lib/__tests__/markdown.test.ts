import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';

describe('renderMarkdown XSS hardening', () => {
  it('escaped Raw-HTML auch in Text- und Code-Bloecken', () => {
    const html = renderMarkdown(
      '<img src=x onerror="alert(1)">\n\n```\n<script>alert(2)</script>\n```',
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<svg onload=alert(1)>', '//evil.test'])(
    'macht ein unsicheres Markdown-Linkziel inert: %s',
    (href) => {
      expect(renderMarkdown(`[Link](${href})`)).toContain('<a href="#">Link</a>');
    },
  );

  it('laesst keinen Attributausbruch aus einem Linkziel zu', () => {
    const html = renderMarkdown('[Link](https://example.test/" onmouseover="alert(1))');

    expect(html).not.toContain('onmouseover="');
    expect(html).not.toContain('href="javascript:');
  });
});
