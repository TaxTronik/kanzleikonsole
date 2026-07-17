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

describe('renderMarkdown Tabellen und Trennlinien', () => {
  it('rendert eine GitHub-Tabelle mit Kopf und Zellen', () => {
    const html = renderMarkdown(
      ['| Bereich | Bewertung |', '|---|---|', '| **§ 162 AO** | Wahrscheinlich gegeben |'].join(
        '\n',
      ),
    );

    expect(html).toContain('<table><thead><tr><th>Bereich</th><th>Bewertung</th></tr></thead>');
    expect(html).toContain('<td><strong>§ 162 AO</strong></td>');
    expect(html).toContain('<td>Wahrscheinlich gegeben</td>');
  });

  it('escaped HTML in Tabellenzellen', () => {
    const html = renderMarkdown('| a |\n|---|\n| <script>x</script> |');

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rendert --- als horizontale Trennlinie, aber - Liste weiterhin als Liste', () => {
    const html = renderMarkdown('Absatz\n\n---\n\n- Punkt');

    expect(html).toContain('<hr>');
    expect(html).toContain('<li>Punkt</li>');
  });

  it('beendet einen Absatz vor einer direkt folgenden Tabelle', () => {
    const html = renderMarkdown('Text davor\n| a | b |\n|---|---|\n| 1 | 2 |');

    expect(html).toContain('<p>Text davor</p>');
    expect(html).toContain('<td>1</td>');
  });
});
