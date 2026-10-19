// TCMS Stufe 3, Bereich C: Abruf eines Nachweises über die
// Dokumentauslieferung der kanzleikonsole mit SHA-256-Abgleich gegen den
// Verweis des Tax-CMS (server/tcms/durchfuehrung/nachweis-download.ts). Der
// Route-Einstieg (tcmsMandantRoute) ist in server/tcms/__tests__/route.test.ts
// geprüft; hier beginnt der Ablauf mit einer geprüften Route.
// Fachkatalog: TCMS-NACHWEIS-001
import { NextRequest, NextResponse } from 'next/server';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lesen: vi.fn(),
  laden: vi.fn(),
  ausliefern: vi.fn(),
  zugriff: vi.fn(),
  findMany: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: h.zugriff }));
vi.mock('@/server/documents/delivery', () => ({
  loadDocumentDelivery: h.laden,
  documentDownloadResponse: h.ausliefern,
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ document: { findMany: h.findMany } }),
  ),
}));
vi.mock('@/server/tcms/route', async (original) => ({
  ...(await original<typeof import('@/server/tcms/route')>()),
  tcmsRouteLesen: h.lesen,
}));

import { withTenantContext } from '@taxtronik/db/tenant-context';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { tcmsRouteAntwort, type TcmsMandantRoute } from '@/server/tcms/route';
import { nachweisAusliefern } from '../nachweis-download';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const STAFF = 'b1000000-0000-4000-8000-000000000001';
const DOKUMENT = 'c3000000-0000-4000-8000-000000000001';
const SESSION = { user: { tenantId: TENANT, staffId: STAFF } };
const ROUTE = {
  ok: true,
  art: 'MANDANT',
  session: SESSION,
  akteur: {},
  mandantId: MANDANT,
} as unknown as TcmsMandantRoute;
const NACHWEIS = 'cmvf9s01r0000lh7dmncuj80d';
const SHA = 'a'.repeat(64);
const GROESSE = 48213;
const req = () =>
  new NextRequest(`http://localhost/api/staff/clients/${MANDANT}/tcms/nachweise/${NACHWEIS}`);

function version(sha = SHA, groesse = GROESSE) {
  return {
    sha256: Buffer.from(sha, 'hex'),
    sizeBytes: BigInt(groesse),
    scanStatus: 'CLEAN',
    scanCompletedAt: new Date('2026-10-19T10:00:00Z'),
  };
}
function geladen(sha = SHA, groesse = GROESSE) {
  return {
    title: 'Kontoabstimmung September',
    mimeType: 'application/pdf',
    classification: 'GENERAL',
    clientId: MANDANT,
    bucket: 'b',
    key: 'k',
    storageVersionId: 'v',
    sha256: Buffer.from(sha, 'hex'),
    sizeBytes: BigInt(groesse),
    isPoaDocument: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.nachweisLesen(), requestId: 'r' });
  h.findMany.mockResolvedValue([{ id: DOKUMENT, versions: [version()] }]);
  h.laden.mockResolvedValue(geladen());
  h.ausliefern.mockResolvedValue(new NextResponse('PDF', { status: 200 }));
  h.zugriff.mockResolvedValue(true);
});

describe('nachweisAusliefern', () => {
  it('liefert über die Dokumentauslieferung mit den Rechten der kanzleikonsole aus', async () => {
    const antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(200);
    expect(antwort.headers.get('x-content-type-options')).toBe('nosniff');
    expect(h.lesen).toHaveBeenCalledWith(ROUTE, ENDPUNKTE.nachweisLesen, {
      params: { nachweisId: NACHWEIS },
    });
    // Vorabgleich nur unter Dokumenten dieses Mandanten.
    expect(h.findMany.mock.calls[0]![0].where).toMatchObject({
      id: { in: [DOKUMENT] },
      tenantId: TENANT,
      clientId: MANDANT,
      deletedAt: null,
    });
    const optionen = h.laden.mock.calls[0]![0];
    expect(optionen).toMatchObject({
      tenantId: TENANT,
      actorId: STAFF,
      actorType: 'STAFF',
      documentId: DOKUMENT,
      action: 'document.download',
      where: { id: DOKUMENT, tenantId: TENANT, clientId: MANDANT, deletedAt: null },
    });
    expect(h.ausliefern).toHaveBeenCalledWith(geladen(), { mimeSource: 'validated-document' });
  });

  it('Mandantenzugriff im Gate der Auslieferung; fremder Mandant nie', async () => {
    await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    const { authorize } = h.laden.mock.calls[0]![0];
    const tx = { tx: true };
    await expect(authorize(tx, { id: DOKUMENT, clientId: MANDANT })).resolves.toBe(true);
    expect(h.zugriff).toHaveBeenCalledWith(tx, SESSION, MANDANT);
    h.zugriff.mockClear();
    await expect(
      authorize(tx, { id: DOKUMENT, clientId: 'a1000000-0000-4000-8000-000000004720' }),
    ).resolves.toBe(false);
    await expect(authorize(tx, { id: DOKUMENT, clientId: null })).resolves.toBe(false);
    expect(h.zugriff).not.toHaveBeenCalled();
    h.zugriff.mockResolvedValue(false);
    await expect(authorize(tx, { id: DOKUMENT, clientId: MANDANT })).resolves.toBe(false);
  });

  it('Abweichung im Vorabgleich: 409, kein Laden (kein Abrufnachweis), keine Bytes', async () => {
    h.findMany.mockResolvedValue([{ id: DOKUMENT, versions: [version('b'.repeat(64))] }]);
    const antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ error: 'evidence_mismatch' });
    expect(antwort.headers.get('cache-control')).toBe('private, no-store');
    expect(h.laden).not.toHaveBeenCalled();
    expect(h.ausliefern).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it('Größe weicht ab: 409', async () => {
    h.findMany.mockResolvedValue([{ id: DOKUMENT, versions: [version(SHA, GROESSE + 1)] }]);
    expect((await nachweisAusliefern(req(), ROUTE, NACHWEIS)).status).toBe(409);
    expect(h.laden).not.toHaveBeenCalled();
  });

  it('geladene Fassung weicht nach dem Vorabgleich ab: 409, keine Bytes', async () => {
    h.laden.mockResolvedValue(geladen('c'.repeat(64)));
    const antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(409);
    expect(h.ausliefern).not.toHaveBeenCalled();
    h.laden.mockResolvedValue(geladen(SHA, GROESSE - 1));
    expect((await nachweisAusliefern(req(), ROUTE, NACHWEIS)).status).toBe(409);
    expect(h.ausliefern).not.toHaveBeenCalled();
  });

  it('Dokument fehlt, gelöscht, ungescannt oder nicht zugänglich: 404', async () => {
    h.findMany.mockResolvedValue([]);
    let antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(404);
    expect(await antwort.json()).toMatchObject({ error: 'evidence_unavailable' });
    h.findMany.mockResolvedValue([
      { id: DOKUMENT, versions: [{ ...version(), scanStatus: 'PENDING' }] },
    ]);
    expect((await nachweisAusliefern(req(), ROUTE, NACHWEIS)).status).toBe(404);
    h.findMany.mockResolvedValue([{ id: DOKUMENT, versions: [version()] }]);
    h.laden.mockResolvedValue(null);
    antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(404);
    expect(h.ausliefern).not.toHaveBeenCalled();
  });

  it('Verweis ohne Dokument der kanzleikonsole (Demo-Ablagepfad): 404 ohne Datenbankzugriff', async () => {
    const daten = tcmsFixtures.nachweisLesen();
    daten.nachweis.dokumentId = '45/456ba7a4e…';
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: 'r' });
    expect((await nachweisAusliefern(req(), ROUTE, NACHWEIS)).status).toBe(404);
    expect(withTenantContext).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.laden).not.toHaveBeenCalled();
  });

  it('ungültige Nachweis-ID: 404 ohne Dienstaufruf; Abbruch des Dienstes unverändert', async () => {
    expect((await nachweisAusliefern(req(), ROUTE, '../x')).status).toBe(404);
    expect(h.lesen).not.toHaveBeenCalled();
    const abbruch = tcmsRouteAntwort('KEIN_RECHT');
    h.lesen.mockResolvedValue({ ok: false, antwort: abbruch });
    await expect(nachweisAusliefern(req(), ROUTE, NACHWEIS)).resolves.toBe(abbruch);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it('Ablage nicht lesbar: 503 ohne Rohtext', async () => {
    h.ausliefern.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.3:8333'));
    const antwort = await nachweisAusliefern(req(), ROUTE, NACHWEIS);
    expect(antwort.status).toBe(503);
    expect(JSON.stringify(await antwort.json())).not.toContain('10.0.0.3');
  });
});
