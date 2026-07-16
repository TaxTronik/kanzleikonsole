import { describe, expect, it } from 'vitest';
import { escapeHtml, safeHref } from '../markdown-safety';

describe('Markdown HTML safety primitives', () => {
  it('escaped alle HTML- und Attributbegrenzer', () => {
    expect(escapeHtml(`<script data-x="'">&</script>`)).toBe(
      '&lt;script data-x=&quot;&#39;&quot;&gt;&amp;&lt;/script&gt;',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.test/x'])(
    'verwirft nicht erlaubtes href %s',
    (href) => {
      expect(safeHref(href)).toBe('#');
    },
  );

  it('erlaubt Web-, Mail- und lokale Links', () => {
    expect(safeHref('https://example.test/a?x=1&y=2')).toBe('https://example.test/a?x=1&y=2');
    expect(safeHref('mailto:post@example.test')).toBe('mailto:post@example.test');
    expect(safeHref('/staff/documents/123')).toBe('/staff/documents/123');
  });

  it('neutralisiert Attributbegrenzer und Kontrollzeichen im Ziel', () => {
    expect(safeHref('https://example.test/" onmouseover="x\n')).toBe(
      'https://example.test/%22 onmouseover=%22x%0A',
    );
  });
});
