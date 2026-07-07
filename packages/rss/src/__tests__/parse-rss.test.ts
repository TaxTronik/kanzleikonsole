// =============================================================================
// Unit-Tests: parseRss (@taxtronik/rss).
//
// Reiner Parser-Test — der Fetcher (safeFetch, Body-Cap) braucht Netzwerk und
// wird hier bewusst NICHT angefasst. Abgedeckt:
//   - kaputtes/unvollständiges XML wirft nicht (liefert leer/teilweise)
//   - CDATA-Blöcke
//   - Entities: named, dezimal, hex, Astral-Codepoints (Regression
//     fromCharCode → fromCodePoint), kaputte numerische Entities
//   - ungültiges pubDate → publishedAt null (Regression: Invalid Date hätte
//     den DB-Insert geworfen und das Item komplett verloren)
//   - Link-Schema-Filter (S-1), Pflichtfelder, guid-Fallback
//   - Längen-Caps: title 500, summary 2000
// =============================================================================

import { describe, it, expect } from 'vitest';
import { parseRss } from '../index';

const SOURCE = 'https://news.example.de/feed.xml';

function feedWith(itemsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test</title>${itemsXml}</channel></rss>`;
}

function item(fields: { title?: string; link?: string; description?: string; guid?: string; pubDate?: string }): string {
  const tags: string[] = [];
  if (fields.title !== undefined) tags.push(`<title>${fields.title}</title>`);
  if (fields.link !== undefined) tags.push(`<link>${fields.link}</link>`);
  if (fields.description !== undefined) tags.push(`<description>${fields.description}</description>`);
  if (fields.guid !== undefined) tags.push(`<guid>${fields.guid}</guid>`);
  if (fields.pubDate !== undefined) tags.push(`<pubDate>${fields.pubDate}</pubDate>`);
  return `<item>${tags.join('')}</item>`;
}

describe('parseRss — Grundfälle', () => {
  it('parst ein vollständiges Item mit allen Feldern', () => {
    const xml = feedWith(
      item({
        title: 'BMF-Schreiben zur E-Rechnung',
        link: 'https://news.example.de/a1',
        description: 'Zusammenfassung.',
        guid: 'guid-1',
        pubDate: 'Tue, 10 Jun 2025 07:00:00 GMT',
      }),
    );
    const items = parseRss(xml, SOURCE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: SOURCE,
      guid: 'guid-1',
      title: 'BMF-Schreiben zur E-Rechnung',
      summary: 'Zusammenfassung.',
      link: 'https://news.example.de/a1',
    });
    expect(items[0]!.publishedAt).toEqual(new Date('2025-06-10T07:00:00.000Z'));
  });

  it('mehrere Items werden alle geliefert', () => {
    const xml = feedWith(
      item({ title: 'A', link: 'https://x.de/a' }) + item({ title: 'B', link: 'https://x.de/b' }),
    );
    expect(parseRss(xml, SOURCE).map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('fehlende guid → Fallback auf link', () => {
    const xml = feedWith(item({ title: 'A', link: 'https://x.de/a' }));
    expect(parseRss(xml, SOURCE)[0]!.guid).toBe('https://x.de/a');
  });

  it('fehlende description → summary null', () => {
    const xml = feedWith(item({ title: 'A', link: 'https://x.de/a' }));
    expect(parseRss(xml, SOURCE)[0]!.summary).toBeNull();
  });
});

describe('parseRss — kaputtes/unvollständiges XML wirft nicht', () => {
  it('leerer String → leeres Array', () => {
    expect(parseRss('', SOURCE)).toEqual([]);
  });

  it('kein XML → leeres Array', () => {
    expect(parseRss('hallo welt, kein feed', SOURCE)).toEqual([]);
  });

  it('abgeschnittenes Item ohne </item> → wird ignoriert', () => {
    const xml = feedWith('<item><title>Abgeschnitten</title><link>https://x.de/a</link>');
    expect(parseRss(xml, SOURCE)).toEqual([]);
  });

  it('ein vollständiges + ein abgeschnittenes Item → nur das vollständige', () => {
    const xml = feedWith(
      item({ title: 'OK', link: 'https://x.de/ok' }) + '<item><title>Kaputt</title>',
    );
    const items = parseRss(xml, SOURCE);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('OK');
  });

  it('Item ohne title → übersprungen', () => {
    const xml = feedWith(item({ link: 'https://x.de/a' }));
    expect(parseRss(xml, SOURCE)).toEqual([]);
  });

  it('Item ohne link → übersprungen', () => {
    const xml = feedWith(item({ title: 'A' }));
    expect(parseRss(xml, SOURCE)).toEqual([]);
  });
});

describe('parseRss — CDATA', () => {
  it('CDATA-Inhalt wird ausgepackt', () => {
    const xml = feedWith(
      item({
        title: '<![CDATA[Umsatzsteuer & Co.]]>',
        link: 'https://x.de/a',
        description: '<![CDATA[Mit <b>Markup</b> im Text.]]>',
      }),
    );
    const [it1] = parseRss(xml, SOURCE);
    expect(it1!.title).toBe('Umsatzsteuer & Co.');
    // HTML-Tags werden nach dem CDATA-Unwrap gestrippt.
    expect(it1!.summary).toBe('Mit Markup im Text.');
  });
});

describe('parseRss — Entities', () => {
  function titleOf(title: string): string {
    const xml = feedWith(item({ title, link: 'https://x.de/a' }));
    return parseRss(xml, SOURCE)[0]!.title;
  }

  it('named Entities (&amp; &lt; &gt; &quot; &apos;)', () => {
    // &lt;b&gt; wird zu <b> dekodiert und anschließend als Tag gestrippt.
    expect(titleOf('Steuern &amp; Abgaben: &quot;neu&quot; &apos;21 &lt;b&gt;fett&lt;/b&gt;')).toBe(
      'Steuern & Abgaben: "neu" \'21 fett',
    );
  });

  it('dezimal-numerische Entities', () => {
    expect(titleOf('K&#228;ufer')).toBe('Käufer');
  });

  it('hex-numerische Entities (&#x…;) — vor dem Fix gar nicht unterstützt', () => {
    expect(titleOf('K&#xE4;ufer')).toBe('Käufer');
    expect(titleOf('K&#XE4;ufer')).toBe('Käufer'); // Großes X / Hex-Ziffern case-insensitiv
  });

  it('Astral-Codepoint dezimal (&#128512;) → 😀 (Regression fromCharCode)', () => {
    expect(titleOf('Stimmung: &#128512;')).toBe('Stimmung: 😀');
  });

  it('Astral-Codepoint hex (&#x1F600;) → 😀', () => {
    expect(titleOf('Stimmung: &#x1F600;')).toBe('Stimmung: 😀');
  });

  it('Codepoint > U+10FFFF → U+FFFD statt RangeError (Item bleibt erhalten)', () => {
    expect(titleOf('kaputt: &#9999999999;')).toBe('kaputt: �');
    expect(titleOf('kaputt: &#x110000;')).toBe('kaputt: �');
  });

  it('&amp; wird NICHT doppelt dekodiert (&amp;#60; → Literal &#60;, nicht <)', () => {
    // &amp;#60; ist die Escapesequenz für den Literaltext „&#60;". Würde &amp;
    // vor der Numerik aufgelöst, entstünde fälschlich „<".
    expect(titleOf('Regel: a &amp;#60; b')).toBe('Regel: a &#60; b');
    expect(titleOf('Doppelt: &amp;amp;')).toBe('Doppelt: &amp;');
  });
});

describe('parseRss — pubDate-Validierung (Regression: Invalid Date → Insert-Crash)', () => {
  function pubOf(pubDate?: string) {
    const xml = feedWith(item({ title: 'A', link: 'https://x.de/a', pubDate }));
    return parseRss(xml, SOURCE)[0]!.publishedAt;
  }

  it('valides RFC-822-Datum → Date', () => {
    expect(pubOf('Tue, 10 Jun 2025 07:00:00 GMT')).toEqual(new Date('2025-06-10T07:00:00.000Z'));
  });

  it('ungültiges pubDate → null statt Invalid Date', () => {
    const published = pubOf('kein datum');
    expect(published).toBeNull();
  });

  it('fehlendes pubDate → null', () => {
    expect(pubOf(undefined)).toBeNull();
  });

  it('Item mit ungültigem pubDate geht nicht verloren', () => {
    const xml = feedWith(item({ title: 'A', link: 'https://x.de/a', pubDate: '???' }));
    expect(parseRss(xml, SOURCE)).toHaveLength(1);
  });
});

describe('parseRss — Link-Filter (S-1) und Caps', () => {
  it.each([['javascript:alert(1)'], ['data:text/html,x'], ['file:///etc/passwd']])(
    'unsicherer Link %s → Item übersprungen',
    (link) => {
      const xml = feedWith(item({ title: 'A', link }));
      expect(parseRss(xml, SOURCE)).toEqual([]);
    },
  );

  it('title wird auf 500 Zeichen gekappt', () => {
    const xml = feedWith(item({ title: 'x'.repeat(600), link: 'https://x.de/a' }));
    expect(parseRss(xml, SOURCE)[0]!.title).toHaveLength(500);
  });

  it('summary wird auf 2000 Zeichen gekappt', () => {
    const xml = feedWith(
      item({ title: 'A', link: 'https://x.de/a', description: 'y'.repeat(2500) }),
    );
    expect(parseRss(xml, SOURCE)[0]!.summary).toHaveLength(2000);
  });

  it('HTML-Markup wird aus title und summary gestrippt', () => {
    const xml = feedWith(
      item({
        title: '<![CDATA[Ein <em>wichtiger</em> Hinweis]]>',
        link: 'https://x.de/a',
        description: '<![CDATA[<p>Absatz</p> mit <a href="https://x.de">Link</a>]]>',
      }),
    );
    const [it1] = parseRss(xml, SOURCE);
    expect(it1!.title).toBe('Ein wichtiger Hinweis');
    expect(it1!.summary).toBe('Absatz mit Link');
  });
});
