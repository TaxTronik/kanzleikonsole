import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '@/server/timeline/build';

const mocks = vi.hoisted(() => ({
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  buildClientTimeline: vi.fn(),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: mocks.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/timeline/build', () => ({ buildClientTimeline: mocks.buildClientTimeline }));

import ClientTimelinePage from '../page';

function event(id: string, occurredAt = '2026-09-01T12:00:00Z'): TimelineEvent {
  return {
    id,
    occurredAt: new Date(occurredAt),
    kind: 'document_uploaded',
    title: `Dokument ${id}`,
  };
}

async function render(limit?: string) {
  return renderToStaticMarkup(
    await ClientTimelinePage({
      params: Promise.resolve({ id: 'client' }),
      searchParams: Promise.resolve({ limit }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffPage.mockResolvedValue({ user: { tenantId: 'tenant', staffId: 'staff' } });
  mocks.withTenantContext.mockResolvedValue({ id: 'client', name: 'Testmandant' });
  mocks.buildClientTimeline.mockResolvedValue([]);
});

describe('Timeline-Seite: gültige Seiten und einheitliche Datumsanzeige', () => {
  it.each([
    ['abc', 100],
    ['Infinity', 100],
    ['25.5', 25],
  ])('begrenzt %s auf ein gültiges ganzzahliges Query-Limit', async (input, expected) => {
    await render(input as string);
    expect(mocks.buildClientTimeline.mock.calls[0]![1].limit).toBe(expected);
  });

  it('bietet an der Obergrenze keinen wirkungslosen Mehr-laden-Link an', async () => {
    mocks.buildClientTimeline.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => event(String(i))),
    );
    expect(await render('500')).not.toContain('Mehr Ereignisse laden');
  });

  it('lädt unterhalb der Obergrenze mehr Ereignisse', async () => {
    mocks.buildClientTimeline.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => event(String(i))),
    );
    expect(await render('100')).toContain('/timeline?limit=200');
  });

  it.each([
    ['Sommerzeit', '2026-07-01T22:30:00Z', '2026-07-02T08:00:00Z', 'Donnerstag, 02. Juli 2026'],
    ['Winterzeit', '2026-12-01T23:30:00Z', '2026-12-02T08:00:00Z', 'Mittwoch, 02. Dezember 2026'],
  ])(
    'ordnet Mitternachtsereignisse in %s demselben Berliner Kalendertag zu',
    async (_season, first, second, label) => {
      mocks.buildClientTimeline.mockResolvedValue([
        event('later', second),
        event('earlier', first),
      ]);
      const html = await render();
      expect(html.match(/<section>/g)).toHaveLength(1);
      expect(html).toContain(label);
    },
  );
});
