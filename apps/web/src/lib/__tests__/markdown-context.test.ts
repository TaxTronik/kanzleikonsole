import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderMarkdown } from '../markdown';

const image = '/api/staff/knowledge/attachments/11111111-1111-4111-8111-111111111111';

describe('Markdown-Token behalten ihren HTML-Kontext', () => {
  it('beendet große unvollständige Tokens und Tabellentrenner ohne blockierenden Backtracking-Lauf', () => {
    const inputs = [
      '['.repeat(100_000),
      '[x]('.repeat(25_000),
      '<u>'.repeat(33_333),
      '<span style="color: #abcdef">'.repeat(3_000),
      '**' + '`x` '.repeat(2_500),
      '~~' + '`x` '.repeat(2_500),
      '| header |\n' + ' '.repeat(10_000) + '-x',
      '| header |\n' + ' '.repeat(20_000) + '-x',
    ];
    // A process deadline can stop synchronous parser hangs; a Vitest timer cannot.
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';
         import { renderMarkdown } from ${JSON.stringify(new URL('../markdown.ts', import.meta.url).href)};
         const inputs = JSON.parse(readFileSync(0, 'utf8'));
         process.stdout.write(JSON.stringify(inputs.map(input => renderMarkdown(input).length)));`,
      ],
      { input: JSON.stringify(inputs), encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const lengths: number[] = JSON.parse(child.stdout);
    expect(lengths).toHaveLength(inputs.length);
    lengths.forEach((length, index) => expect(length).toBeGreaterThan(inputs[index]!.length));
  });

  it('behandelt Bildbeschriftungen einschließlich Anführungszeichen nur als Attributtext', () => {
    const alt = '**Titel** <u>Text</u> " onerror="alert(1)';
    expect(renderMarkdown(`![${alt}](${image})`)).toBe(
      `<p><img src="${image}" alt="**Titel** &lt;u&gt;Text&lt;/u&gt; &quot; onerror=&quot;alert(1)" loading="lazy"></p>`,
    );
  });

  it('interpretiert Entity-Text im Linkziel nicht als HTML-Attributtrenner', () => {
    expect(renderMarkdown('[Text](https://example.test/?x=&quot; onmouseover=&quot;evil)')).toBe(
      '<p><a href="https://example.test/?x=&amp;quot; onmouseover=&amp;quot;evil">Text</a></p>',
    );
  });

  it.each(['javascript:evil', 'data:text/html,evil', '//example.test', 'jav&#x61;script:evil'])(
    'bewahrt die URL-Prüfung auch in erlaubten Textstil-Tokens: %s',
    (url) => {
      expect(renderMarkdown(`<span style="color: #abcdef"><u>[Link](${url})</u></span>`)).toBe(
        '<p><span style="color: #abcdef"><u><a href="#">Link</a></u></span></p>',
      );
    },
  );

  it('escaped unbekanntes HTML im Inhalt eines erlaubten Textstil-Tokens', () => {
    expect(renderMarkdown('<u><svg onload="evil"></svg></u>')).toBe(
      '<p><u>&lt;svg onload=&quot;evil&quot;&gt;&lt;/svg&gt;</u></p>',
    );
  });

  it('lässt Codezeichen innerhalb von URL-Daten unverändert als URL-Daten', () => {
    expect(renderMarkdown('[Link](https://example.test/`**literal**`)')).toBe(
      '<p><a href="https://example.test/%60**literal**%60">Link</a></p>',
    );
  });
});
