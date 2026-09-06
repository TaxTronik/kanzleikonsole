import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderMarkdown } from '../markdown';

describe('renderMarkdown robuste Textverarbeitung', () => {
  it('beendet auch unvollständige Tabellen ohne blockierende Endlosschleife', () => {
    // Der Prozess-Timeout bleibt wirksam, wenn eine Regression den JS-Thread blockiert.
    const input = ['| Text', 'Vorher\n| a | b |\nkein Trenner', '|', '   | unfertig\n\n# Danach'];
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';
         import { renderMarkdown } from ${JSON.stringify(new URL('../markdown.ts', import.meta.url).href)};
         process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0, 'utf8')).map(renderMarkdown)));`,
      ],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, windowsHide: true },
    );

    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      '<p>| Text</p>',
      '<p>Vorher | a | b | kein Trenner</p>',
      '<p>|</p>',
      '<p>   | unfertig</p>\n<h1>Danach</h1>',
    ]);
  });

  it('zeigt Inline-Code einschließlich Markdown und Editor-HTML wortgetreu an', () => {
    expect(renderMarkdown('`**fett** [Link](https://example.test) <u>Text</u>`')).toBe(
      '<p><code>**fett** [Link](https://example.test) &lt;u&gt;Text&lt;/u&gt;</code></p>',
    );
    expect(renderMarkdown('**Text `*literal*`** und *kursiv*')).toBe(
      '<p><strong>Text <code>*literal*</code></strong> und <em>kursiv</em></p>',
    );
  });

  it('erhält private Unicode-Zeichen unabhängig von Editor-Textstilen', () => {
    expect(renderMarkdown('\uE0000\uE001 <u>Text</u> \uE0009\uE001')).toBe(
      '<p>\uE0000\uE001 <u>Text</u> \uE0009\uE001</p>',
    );
  });

  it('behandelt Formatierungszeichen in Linkzielen als URL-Daten', () => {
    expect(renderMarkdown('[**Link**](https://example.test/**path**?a=1&b=2)')).toBe(
      '<p><a href="https://example.test/**path**?a=1&amp;b=2"><strong>Link</strong></a></p>',
    );
    expect(
      renderMarkdown('[Link](https://example.test/<span style="color: #abcdef">x</span>)'),
    ).toBe(
      '<p><a href="https://example.test/%3Cspan style=%22color: #abcdef%22%3Ex%3C/span%3E">Link</a></p>',
    );
  });
});

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

  it('rendert ausschließlich authentifizierte Wissensanhänge als Bilder', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(renderMarkdown(`![Akte](/api/staff/knowledge/attachments/${id})`)).toContain(
      `<img src="/api/staff/knowledge/attachments/${id}" alt="Akte" loading="lazy">`,
    );
    expect(renderMarkdown('![Extern](https://tracking.example/pixel.png)')).toContain(
      '<img src="#"',
    );
    expect(renderMarkdown('![Unsicher](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('rendert ausschließlich die vom Inline-Editor erlaubten Textstile', () => {
    const html = renderMarkdown(
      '<span style="color: #dc2626; background-color: #fef08a; font-size: 1.25rem">**Wichtig**</span>',
    );

    expect(html).toContain(
      '<span style="color: #dc2626; background-color: #fef08a; font-size: 1.25rem"><strong>Wichtig</strong></span>',
    );
    expect(renderMarkdown('<u>Unterstrichen</u> und ~~gestrichen~~')).toContain(
      '<u>Unterstrichen</u> und <s>gestrichen</s>',
    );
  });

  it('verwirft gefährliche Inline-Styles und unbekanntes HTML', () => {
    const html = renderMarkdown(
      '<span style="color: red; background-image: url(javascript:alert(1))">Text</span><script>alert(2)</script>',
    );

    expect(html).not.toContain('style=');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;');
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
