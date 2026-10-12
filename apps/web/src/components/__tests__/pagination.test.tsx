// Cursor-Pagination; `capped` für begrenzte Trefferlisten (Review-Finding P-10,
// Welle 15: Staff-Posteingangssuche zeigt nur die jüngsten Treffer).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Pagination } from '../pagination';

describe('Pagination', () => {
  const baseQs = new URLSearchParams({ q: 'Belege', scope: 'all' });

  it('zeigt die genaue Trefferzahl und am Ende „Ende“', () => {
    const html = renderToStaticMarkup(
      <Pagination
        basePath="/staff/inbox"
        baseQs={baseQs}
        currentCursor={null}
        nextCursor={null}
        totalCount={12}
        shownCount={12}
      />,
    );
    expect(html).toContain('12 Treffer · zeige 12');
    expect(html).not.toContain('Mehr als');
    expect(html).toContain('Ende');
    expect(html).not.toContain('Erste Seite');
  });

  it('meldet begrenzte Treffer und verlinkt Ältere sowie die erste Seite mit allen Filtern', () => {
    const html = renderToStaticMarkup(
      <Pagination
        basePath="/staff/inbox"
        baseQs={baseQs}
        currentCursor="1767225600000_00000000-0000-4000-8000-000000000001"
        nextCursor="1767225500000_00000000-0000-4000-8000-000000000002"
        totalCount={500}
        shownCount={50}
        capped
      />,
    );
    expect(html).toContain('Mehr als 500 Treffer · zeige 50');
    expect(html).toContain(
      'href="/staff/inbox?q=Belege&amp;scope=all&amp;cursor=1767225500000_00000000-0000-4000-8000-000000000002"',
    );
    expect(html).toContain('href="/staff/inbox?q=Belege&amp;scope=all"');
    expect(html).toContain('Erste Seite');
  });

  it('verweist am Ende einer begrenzten Liste auf das Verfeinern statt auf „Ende“', () => {
    const html = renderToStaticMarkup(
      <Pagination
        basePath="/staff/inbox"
        baseQs={baseQs}
        currentCursor="1767225600000_00000000-0000-4000-8000-000000000001"
        nextCursor={null}
        totalCount={500}
        shownCount={50}
        capped
      />,
    );
    expect(html).toContain('Suche verfeinern');
    expect(html).not.toContain('>Ende<');
  });
});
