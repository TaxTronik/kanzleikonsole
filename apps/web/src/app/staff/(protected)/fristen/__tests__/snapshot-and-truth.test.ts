// @vitest-environment jsdom
// Fachkatalog: TAX-CONTROL-STATUS-001
// Fristenkontrollbuch — Snapshot- und Wahrheitsgrenzen als Render- und
// Verhaltenstest (B-08, Welle 15) statt Quelltextprüfung. Den Tagesabschluss
// (transactionIsolationLevel RepeatableRead) prüft actions.test.ts.
import { screen } from '@testing-library/react';
import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import type { FristEintrag } from '@/server/fristen/eintrag';

const h = vi.hoisted(() => ({
  modules: { taxNotices: true, reminders: true },
  withTenantContext: vi.fn(),
  loadSeite: vi.fn(),
  loadKontrollbuch: vi.fn(),
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: () => false }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn(async () => h.modules) }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/fristen/kontrollbuch', () => ({
  loadKontrollbuchSeite: h.loadSeite,
  loadKontrollbuch: h.loadKontrollbuch,
}));
vi.mock('@/server/fristen/tagesabschluss', () => ({
  loadDailyReviewSummary: vi.fn(async () => null),
  loadDailyReviewPreview: vi.fn(async () => null),
}));
vi.mock('../daily-review-form', () => ({ DailyReviewForm: () => null }));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: vi.fn(async () => ({ ok: true })),
  getClientIp: () => '203.0.113.7',
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import FristenPage from '../page';
import { GET } from '../../../../api/staff/fristen/export/route';

function eintrag(overrides: Partial<FristEintrag>): FristEintrag {
  return {
    quelle: 'EINSPRUCHSFRIST',
    kontrollart: 'FRIST',
    id: 'e1',
    titel: 'Einspruch ESt 2025',
    clientId: 'client-1',
    clientName: 'Muster GmbH',
    faelligAm: new Date('2026-10-20T00:00:00.000Z'),
    erledigt: false,
    kontrollzustand: 'OPEN',
    kontrollhinweis: null,
    erledigtAm: null,
    erledigtVon: null,
    verantwortlich: null,
    href: '/staff/x',
    ...overrides,
  } as FristEintrag;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modules = { taxNotices: true, reminders: true };
  h.withTenantContext.mockImplementation(async (_ctx, fn) => fn({}));
  h.loadSeite.mockResolvedValue({
    heute: new Date('2026-10-12T00:00:00.000Z'),
    offen: [],
    erledigt: [],
    offenGesamt: 0,
    ueberfaellig: 0,
    erledigtGesamt: 0,
    seite: 1,
    erledigtSeite: 1,
    seitenGroesse: 200,
    tagesabschluss: null,
  });
});

describe('Fristenkontrollbuch — Snapshot- und Wahrheitsgrenzen', () => {
  it('liest Seite und CSV-Auszug in einem stabilen REPEATABLE-READ-Snapshot', async () => {
    // Regression: Unter READ COMMITTED könnte eine nach der Late-ID-Abfrage
    // committete verspätete Einlegung in der Hauptquery erscheinen und dort
    // fälschlich als fristwahrend geschlossen werden.
    await renderServer(FristenPage({ searchParams: Promise.resolve({}) }));
    expect(h.withTenantContext).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });

    h.withTenantContext.mockClear();
    h.loadKontrollbuch.mockResolvedValue([]);
    await GET({
      nextUrl: new URL('http://localhost/api/staff/fristen/export?tage=30'),
      headers: new Headers(),
    } as unknown as NextRequest);
    expect(h.withTenantContext).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('benennt alle fünf Quellen und den CSV-Export wahrheitsgemäß als Kontrollauszug', async () => {
    await renderServer(FristenPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByText(
        /^Steuertermine, Bescheidprüffälle \/ Einspruchsfristen, Klagefristen, Anforderungen, Wiedervorlagen — 0 offen/,
      ),
    ).toBeTruthy();
    const csv = screen.getByRole('link', { name: 'CSV-Auszug' });
    expect(csv.getAttribute('title')).toContain('CSV-Kontrollauszug');
    expect(csv.getAttribute('title')).toContain('kein Erledigungsnachweis');
    expect(document.body.textContent).not.toContain('CSV-Nachweis');
  });

  it('nennt ohne Steuermodul nur die tatsächlich geladenen Quellen', async () => {
    h.modules = { taxNotices: false, reminders: false };
    await renderServer(FristenPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/^Anforderungen — 0 offen/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Einspruchsfristen');
  });

  it('übernimmt die wahrheitsgemäße Anzeigeart und den Kontrollhinweis in den CSV-Auszug', async () => {
    h.loadKontrollbuch.mockResolvedValue([
      eintrag({
        artLabel: 'Bescheid-Prüftermin (keine Einspruchsfrist)',
        kontrollhinweis: 'Fristberechnung fehlt',
      }),
      eintrag({ id: 'e2', quelle: 'KLAGEFRIST', titel: 'Klage', kontrollhinweis: null }),
    ]);
    const response = await GET({
      nextUrl: new URL('http://localhost/api/staff/fristen/export?tage=30'),
      headers: new Headers(),
    } as unknown as NextRequest);
    const lines = (await response.text())
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    const header = lines[0]!.split(';');
    const row = (line: string) => Object.fromEntries(line.split(';').map((v, i) => [header[i], v]));
    expect(header).toContain('Art');
    expect(header).toContain('Kontrollhinweis');
    expect(row(lines[1]!)).toMatchObject({
      Art: 'Bescheid-Prüftermin (keine Einspruchsfrist)',
      Kontrollhinweis: 'Fristberechnung fehlt',
    });
    expect(row(lines[2]!)).toMatchObject({ Art: 'Klagefrist', Kontrollhinweis: '' });
  });
});
