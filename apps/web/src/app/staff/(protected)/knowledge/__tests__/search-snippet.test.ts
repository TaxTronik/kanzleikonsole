// Suchtreffer-Ausschnitt als Klartextsegmente (SAST-Befund XSS im
// Such-Snippet): Artikeltext bleibt Text, nur die ts_headline-Trenner werden
// zu Hervorhebungen.
import { describe, expect, it } from 'vitest';
import { parseSearchSnippet } from '../search-snippet';

describe('parseSearchSnippet', () => {
  it('trennt Treffer und Umgebungstext', () => {
    expect(parseSearchSnippet('Die <mark>Pauschalen</mark> für <mark>Reisen</mark> ...')).toEqual([
      { text: 'Die ', mark: false },
      { text: 'Pauschalen', mark: true },
      { text: ' für ', mark: false },
      { text: 'Reisen', mark: true },
      { text: ' ...', mark: false },
    ]);
  });

  it('lässt HTML und Entities im Artikeltext als Klartext stehen', () => {
    const raw = '<img src=x onerror=alert(1)> &lt;b&gt; <mark>"Treffer\'</mark><script>x</script>';
    expect(parseSearchSnippet(raw)).toEqual([
      { text: '<img src=x onerror=alert(1)> &lt;b&gt; ', mark: false },
      { text: '"Treffer\'', mark: true },
      { text: '<script>x</script>', mark: false },
    ]);
  });

  it('übersteht unpaarige Trenner und leere Eingaben', () => {
    expect(parseSearchSnippet('')).toEqual([]);
    expect(parseSearchSnippet('</mark>a<mark>b')).toEqual([
      { text: 'a', mark: false },
      { text: 'b', mark: true },
    ]);
    expect(parseSearchSnippet('<mark></mark>a<mark>b</mark></mark>c')).toEqual([
      { text: 'a', mark: false },
      { text: 'b', mark: true },
      { text: 'c', mark: false },
    ]);
  });
});
