// Review-Finding P-10, Welle 15: Hinweis, wenn eine Posteingangssuche nur die
// jüngsten Treffer bis zur Grenze zeigt.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SearchLimitHint } from '../search-limit-hint';

describe('SearchLimitHint', () => {
  it('meldet gekürzte Treffer als Status mit der Grenze', () => {
    const html = renderToStaticMarkup(
      <SearchLimitHint paging={{ truncated: true, limit: 1500 }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Mehr als 1.500 Treffer – Suche verfeinern.');
    expect(html).toContain('Angezeigt werden die 1.500 zuletzt aktiven Verläufe.');
  });

  it('bleibt ohne Kürzung und ohne Suche leer', () => {
    expect(
      renderToStaticMarkup(<SearchLimitHint paging={{ truncated: false, limit: 500 }} />),
    ).toBe('');
    expect(renderToStaticMarkup(<SearchLimitHint />)).toBe('');
  });
});
