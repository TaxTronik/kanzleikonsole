// Volltextsuche der Wissensdatenbank: Verfasser und ursprüngliches
// Erstellungsdatum der Treffer als Verhaltenstest der Server-Funktion (B-08,
// Welle 15, ersetzt die Quelltextprüfung aus editor-structure.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), guard: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: h.queryRaw }),
  ),
}));
vi.mock('@/server/actions/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: h.guard,
  staffAction: vi.fn(),
  withStaffModule: () => vi.fn(),
  ActionError: class ActionError extends Error {},
  parseFormData: vi.fn(),
}));

import { searchArticles } from '../actions';

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({ ok: true, ctx: { tenantId: 'tenant-1' } });
});

describe('Wissensdatenbank-Suche', () => {
  it('liefert Verfasser und ursprüngliches Erstellungsdatum je Treffer', async () => {
    const createdAt = new Date('2026-03-02T10:00:00.000Z');
    h.queryRaw.mockResolvedValueOnce([
      {
        id: 'article-1',
        title: 'Reisekosten',
        slug: 'reisekosten',
        snippet: '<mark>Pauschalen</mark>',
        rank: 0.5,
        category_name: 'Lohn',
        author_name: 'Erika Muster',
        created_at: createdAt,
      },
    ]);
    const hits = await searchArticles('  Pauschale ');
    expect(h.guard).toHaveBeenCalledWith({ module: 'knowledge' });
    const [strings, ...values] = h.queryRaw.mock.calls[0]!;
    const sql = (strings as TemplateStringsArray).join('?');
    expect(sql).toMatch(/COALESCE\(s\.full_name, 'Unbekannter Verfasser'\) AS author_name/);
    expect(sql).toMatch(/a\.created_at\s/);
    expect(sql).toMatch(/s\.tenant_id = a\.tenant_id/);
    expect(values).toContain('Pauschale');
    expect(hits).toEqual([
      expect.objectContaining({ authorName: 'Erika Muster', createdAt, categoryName: 'Lohn' }),
    ]);
  });

  it('sucht ohne Modulrecht oder Suchbegriff nicht', async () => {
    expect(await searchArticles('   ')).toEqual([]);
    h.guard.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect(await searchArticles('Pauschale')).toEqual([]);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});
