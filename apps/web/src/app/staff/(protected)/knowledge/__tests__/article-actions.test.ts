// Review-Befund F-01: Artikel anlegen, bearbeiten und löschen melden Gate-,
// Eingabe- und Fachfehler als `{ ok: false, error }` an das Formular (vorher
// stilles Abbrechen bzw. Wurf in error.tsx).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/prisma-client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/auth/rbac', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  return {
    toActionError: (error: unknown) => ({
      ok: false,
      error: error instanceof ActionError ? error.message : 'Unerwarteter Fehler.',
    }),
  };
});
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  const { parseFormData } = await vi.importActual<typeof import('@/server/actions/form-data')>(
    '@/server/actions/form-data',
  );
  return {
    ActionError,
    parseFormData,
    staffActionGuard: h.staffActionGuard,
    withStaffModule: () => vi.fn(),
  };
});

import { createArticleAction, deleteArticleAction, updateArticleAction } from '../actions';

const ARTICLE_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

function articleForm(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const values: Record<string, string> = {
    title: 'Fristenkontrolle',
    body: '## Ablauf',
    categoryId: '',
    attachmentIds: '[]',
    attachmentDraftToken: '',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

describe('Wissensartikel-Actions — Rückkanal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    });
  });

  it('meldet die verweigerte Löschung für Nicht-Admins, statt still nichts zu tun', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nur ADMIN/PARTNER.' });
    const formData = new FormData();
    formData.set('id', ARTICLE_ID);

    await expect(deleteArticleAction(null, formData)).resolves.toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('meldet einen fehlenden Titel mit Feldzuordnung und schreibt nichts', async () => {
    const result = await createArticleAction(null, articleForm({ title: '' }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { title: [expect.any(String)] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet eine fremde Kategorie aus der Transaktion ohne Redirect', async () => {
    const tx = {
      kbCategory: { findFirst: vi.fn().mockResolvedValue(null) },
      kbArticle: { create: vi.fn() },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(
      createArticleAction(null, articleForm({ categoryId: ARTICLE_ID })),
    ).resolves.toEqual({ ok: false, error: 'Kategorie nicht in diesem Tenant.' });
    expect(tx.kbArticle.create).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('meldet einen unbekannten Artikel beim Speichern, statt auf eine leere Seite zu leiten', async () => {
    const tx = { kbArticle: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() } };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(updateArticleAction(null, articleForm({ id: ARTICLE_ID }))).resolves.toEqual({
      ok: false,
      error: 'Artikel nicht gefunden.',
    });
    expect(tx.kbArticle.update).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
