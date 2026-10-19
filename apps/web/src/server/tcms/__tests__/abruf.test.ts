// TCMS Stufe 3, Bereich D: Abruf einer Datei, auf die das Tax-CMS verweist.
// Schutzregeln:
//   - Bytes nur über die Dokumentauslieferung der kanzleikonsole mit deren
//     Filtern (Kanzlei: Mandant + Zugriff; Portal: Sitzungsmandant und für den
//     Mandanten freigegeben, DOC-PORTAL-SHARING-001).
//   - SHA-256 und Größe der neuesten Version müssen dem Verweis entsprechen;
//     sonst keine Auslieferung, kein Abrufnachweis, kein Storage-Zugriff.
// Fachkatalog: TCMS-DIENST-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  laden: vi.fn(),
  antwort: vi.fn(),
  zugriff: vi.fn(),
  version: null as null | { sha256: Uint8Array; sizeBytes: bigint },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: h.zugriff }));
vi.mock('@/server/documents/delivery', () => ({
  loadDocumentDelivery: h.laden,
  documentDownloadResponse: h.antwort,
}));

import { tcmsVerweisAusliefern, type TcmsAuslieferungsAkteur } from '../abruf/auslieferung';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const FREMD = 'a1000000-0000-4000-8000-000000004720';
const DOK = 'd0c00000-0000-4000-8000-0000000000a1';
const SHA = 'ab'.repeat(32);
const BYTES = new Uint8Array(32).fill(0xab);
const VERWEIS = { dokumentId: DOK, sha256: SHA, groesse: 117 };
const REQ = {} as never;

const KANZLEI: TcmsAuslieferungsAkteur = {
  flaeche: 'KANZLEI',
  session: { user: { tenantId: TENANT, staffId: 'b1000000-0000-4000-8000-000000000001' } } as never,
  mandantId: MANDANT,
};
const PORTAL: TcmsAuslieferungsAkteur = {
  flaeche: 'PORTAL',
  session: {
    user: { tenantId: TENANT, contactId: 'b1000000-0000-4000-8000-000000000012' },
  } as never,
  mandantId: MANDANT,
};

interface Optionen {
  where: Record<string, unknown>;
  authorize: (tx: unknown, k: { id: string; clientId: string | null }) => Promise<boolean>;
  actorType: string;
}

/** Ablauf von loadDocumentDelivery in Kurzform: authorize → (Audit) → Quelle. */
function ladenWie(kandidatMandant = MANDANT, geladen = { sha256: BYTES, sizeBytes: 117n }) {
  h.laden.mockImplementation(async (o: Optionen) => {
    const tx = {
      documentVersion: { findFirst: async () => h.version },
    };
    if (!(await o.authorize(tx, { id: DOK, clientId: kandidatMandant }))) return null;
    return { ...geladen, title: 'x', mimeType: 'text/csv' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.version = { sha256: BYTES, sizeBytes: 117n };
  h.zugriff.mockResolvedValue(true);
  h.antwort.mockResolvedValue(new Response('bytes'));
  ladenWie();
});

describe('tcmsVerweisAusliefern', () => {
  it('Kanzlei: Dokument genau dieses Mandanten, Zugriff erneut geprüft, Bytes über die Auslieferung', async () => {
    const r = await tcmsVerweisAusliefern(REQ, KANZLEI, VERWEIS);
    expect(r.art).toBe('AUSGELIEFERT');
    const o = h.laden.mock.calls[0]![0] as Optionen;
    expect(o.where).toEqual({ id: DOK, tenantId: TENANT, clientId: MANDANT, deletedAt: null });
    expect(o.actorType).toBe('STAFF');
    expect(h.zugriff).toHaveBeenCalledWith(expect.anything(), KANZLEI.session, MANDANT);
    expect(h.antwort).toHaveBeenCalledWith(expect.anything(), {
      mimeSource: 'validated-document',
    });
  });

  it('Portal: nur für den Mandanten freigegebene Dokumente (DOC-PORTAL-SHARING-001)', async () => {
    const r = await tcmsVerweisAusliefern(REQ, PORTAL, VERWEIS);
    expect(r.art).toBe('AUSGELIEFERT');
    const o = h.laden.mock.calls[0]![0] as Optionen;
    expect(o.where).toEqual({
      id: DOK,
      tenantId: TENANT,
      clientId: MANDANT,
      deletedAt: null,
      sharedWithClientAt: { not: null },
    });
    expect(o.actorType).toBe('CLIENT_CONTACT');
    expect(h.zugriff).not.toHaveBeenCalled();
  });

  it('SHA-256 der neuesten Version weicht ab: keine Auslieferung (vor Audit und Storage)', async () => {
    h.version = { sha256: new Uint8Array(32).fill(0xcd), sizeBytes: 117n };
    const r = await tcmsVerweisAusliefern(REQ, PORTAL, VERWEIS);
    expect(r).toEqual({ art: 'ABWEICHUNG' });
    expect(h.antwort).not.toHaveBeenCalled();
  });

  it('Größe weicht ab: keine Auslieferung', async () => {
    h.version = { sha256: BYTES, sizeBytes: 118n };
    expect(await tcmsVerweisAusliefern(REQ, KANZLEI, VERWEIS)).toEqual({ art: 'ABWEICHUNG' });
    expect(h.antwort).not.toHaveBeenCalled();
  });

  it('geladene Version weicht ab (zwischen Prüfung und Laden ersetzt): keine Auslieferung', async () => {
    ladenWie(MANDANT, { sha256: new Uint8Array(32).fill(0xcd), sizeBytes: 117n });
    expect(await tcmsVerweisAusliefern(REQ, KANZLEI, VERWEIS)).toEqual({ art: 'ABWEICHUNG' });
    expect(h.antwort).not.toHaveBeenCalled();
  });

  it('fremder Mandant oder kein Zugriff: nicht verfügbar', async () => {
    ladenWie(FREMD);
    expect(await tcmsVerweisAusliefern(REQ, KANZLEI, VERWEIS)).toEqual({ art: 'NICHT_VERFUEGBAR' });
    ladenWie();
    h.zugriff.mockResolvedValue(false);
    expect(await tcmsVerweisAusliefern(REQ, KANZLEI, VERWEIS)).toEqual({ art: 'NICHT_VERFUEGBAR' });
    expect(h.antwort).not.toHaveBeenCalled();
  });

  it('Verweis ohne UUID der kanzleikonsole (z. B. Demo-Ablage): ohne Datenbankzugriff nicht verfügbar', async () => {
    const r = await tcmsVerweisAusliefern(REQ, PORTAL, {
      ...VERWEIS,
      dokumentId: '88/885967c787dd5aad3d8e5979931499c22c355e3429110fc4447174deeb273294',
    });
    expect(r).toEqual({ art: 'NICHT_VERFUEGBAR' });
    expect(h.laden).not.toHaveBeenCalled();
  });
});
