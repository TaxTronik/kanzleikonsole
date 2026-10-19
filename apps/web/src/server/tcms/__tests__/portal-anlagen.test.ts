// TCMS Stufe 3, Bereich D: Anlagen aus dem Mandantenportal. Die kanzleikonsole
// nimmt Dateien über ihre Portal-Dokumentenpipeline an; das Tax-CMS erhält nur
// einen Verweis aus der GESPEICHERTEN Fassung. Schutzregeln:
//   - Dateityp nach Inhalt (Magic Bytes) auf der Positivliste des Vertrags;
//     eine als PDF gemeldete Datei ohne Signatur wird abgewiesen.
//   - Portal-Funktion „Dokumente hochladen“ muss an sein.
//   - Verweis (ID, Typ, Größe, SHA-256) aus dem Commit, nie aus Formularangaben.
//   - Grenzen je Datei, Anzahl und zusammen (Body-Limit der Server-Actions).
// Fachkatalog: TCMS-DIENST-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  erkannt: null as string | null,
  upload: true,
  audit: vi.fn(),
  anlegen: vi.fn(),
  limit: vi.fn(),
  schritte: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/actions/audit', () => ({ audit: h.audit }));
vi.mock('@/server/rate-limit', () => ({ checkPortalWriteLimit: h.limit }));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeaturesTx: async () => ({ documentUpload: h.upload }),
  PortalFeatureDisabledError: class extends Error {},
}));
vi.mock('@/server/documents/upload-helpers', () => ({ createDocumentWithVersion: h.anlegen }));
// Ablauf von runJournaledUpload in Kurzform: check → Bytes → prepare/afterPrepare → commit.
vi.mock('@/server/documents/journaled-upload', () => ({
  uploadFailureCause: (e: unknown) => e,
  runJournaledUpload: async (o: {
    check: (tx: unknown, phase: string) => Promise<unknown>;
    readBytes: () => Promise<Buffer>;
    afterPrepare: (a: { prepared: { sizeBytes: bigint; detectedMime: string | null } }) => void;
    commitTx: (tx: unknown, a: { commit: Record<string, unknown> }) => Promise<unknown>;
  }) => {
    await o.check({}, 'pre');
    h.schritte.push('check');
    const bytes = await o.readBytes();
    const prepared = { sizeBytes: BigInt(bytes.length), detectedMime: h.erkannt };
    o.afterPrepare({ prepared });
    h.schritte.push('prepare');
    const commit = {
      sha256: new Uint8Array(32).fill(0xab),
      sizeBytes: BigInt(bytes.length),
      detectedMime: h.erkannt,
      retentionUntil: null,
    };
    const result = await o.commitTx({}, { commit });
    h.schritte.push('commit');
    return { result, commit, referenced: true };
  },
}));

import {
  effektiverPortalMime,
  PORTAL_ANLAGEN_GESAMT_BYTES,
  portalAblageKontext,
  portalAnlageAblegen,
  portalDateienFeld,
  portalDateiname,
  TcmsAnlageAbgelehnt,
} from '../portal/anlagen';
import { SERVER_ACTION_BODY_LIMIT_BYTES } from '@/lib/upload-limits.mjs';

const MIB = 1024 * 1024;
const G = {
  ctx: { tenantId: 't' } as never,
  tenantId: '7a1e0000-0000-4000-8000-00000000d3e0',
  contactId: 'b1000000-0000-4000-8000-000000000012',
  clientId: 'a1000000-0000-4000-8000-000000004711',
};

function datei(name: string, typ: string, groesse = 3): File {
  return new File([new Uint8Array(groesse).fill(65)], name, { type: typ });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.erkannt = null;
  h.upload = true;
  h.schritte = [];
  h.limit.mockResolvedValue({ ok: true });
  h.anlegen.mockResolvedValue({ document: { id: 'd0c00000-0000-4000-8000-0000000000a1' } });
});

describe('effektiverPortalMime (Typ nach Inhalt)', () => {
  it('erkannter Typ zählt, wenn er auf der Positivliste steht', () => {
    expect(effektiverPortalMime('application/pdf', 'text/plain')).toBe('application/pdf');
    expect(effektiverPortalMime('IMAGE/PNG', '')).toBe('image/png');
    expect(effektiverPortalMime('application/x-msdownload', 'application/pdf')).toBeNull();
    expect(effektiverPortalMime('text/html', 'text/plain')).toBeNull();
  });

  it('ohne Erkennung nur Typen ohne Signatur – eine „PDF“ ohne Signatur wird abgewiesen', () => {
    expect(effektiverPortalMime(null, 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(effektiverPortalMime(null, 'application/msword')).toBe('application/msword');
    expect(effektiverPortalMime(null, 'application/pdf')).toBeNull();
    expect(effektiverPortalMime(null, 'image/png')).toBeNull();
    expect(effektiverPortalMime(null, 'text/html')).toBeNull();
    expect(effektiverPortalMime(null, '')).toBeNull();
  });
});

describe('portalDateiname', () => {
  it('nur der Name, ohne Pfad, Steuer- und Richtungszeichen', () => {
    expect(portalDateiname('C:\\Users\\x\\Bericht.pdf')).toBe('Bericht.pdf');
    expect(portalDateiname('../../etc/passwd')).toBe('passwd');
    expect(portalDateiname('Rech\u202enung\u0000.pdf')).toBe('Rechnung.pdf');
    expect(portalDateiname('..')).toBe('Anlage');
    expect(portalDateiname('')).toBe('Anlage');
    expect(portalDateiname('a'.repeat(300))).toHaveLength(200);
  });
});

describe('portalDateienFeld', () => {
  const feld = portalDateienFeld({ pflicht: true });

  it('leeres Dateifeld des Browsers zählt nicht; Pflicht verlangt eine Datei', () => {
    expect(feld.safeParse([new File([], '')]).success).toBe(false);
    expect(portalDateienFeld({ pflicht: false }).parse([new File([], '')])).toEqual([]);
  });

  it('höchstens 5 Dateien, je 10 MiB, nicht leer', () => {
    expect(
      feld.safeParse(Array.from({ length: 6 }, (_, i) => datei(`${i}.csv`, 'text/csv'))).success,
    ).toBe(false);
    expect(feld.safeParse([datei('gross.pdf', 'application/pdf', 10 * MIB + 1)]).success).toBe(
      false,
    );
    expect(feld.safeParse([new File([], 'leer.csv')]).success).toBe(false);
    expect(feld.safeParse([datei('ok.pdf', 'application/pdf', 10 * MIB)]).success).toBe(true);
  });

  it('zusammen höchstens das Body-Limit der Server-Actions ohne Overhead', () => {
    expect(PORTAL_ANLAGEN_GESAMT_BYTES).toBeLessThan(SERVER_ACTION_BODY_LIMIT_BYTES);
    const drei = Array.from({ length: 3 }, (_, i) => datei(`${i}.pdf`, 'application/pdf', 9 * MIB));
    expect(feld.safeParse(drei).success).toBe(false);
    expect(feld.safeParse(drei.slice(0, 2)).success).toBe(true);
  });
});

describe('portalAblageKontext', () => {
  it('Schreib-Limit des Portals vor jeder Ablage', async () => {
    h.limit.mockResolvedValue({ ok: false, retryAfter: 120 });
    await expect(portalAblageKontext(G)).rejects.toThrow('Zu viele Aktionen');
    expect(h.limit).toHaveBeenCalledWith(G.contactId);
  });
});

describe('portalAnlageAblegen', () => {
  it('Verweis aus der gespeicherten Fassung; Dokument am Sitzungsmandanten, geteilt, auditiert', async () => {
    h.erkannt = 'application/pdf';
    // Browser meldet etwas anderes als den Inhalt: es zählt der erkannte Typ.
    const verweis = await portalAnlageAblegen(G, datei('C:\\tmp\\Prüfung.pdf', 'text/plain', 7));
    expect(verweis).toEqual({
      dokumentId: 'd0c00000-0000-4000-8000-0000000000a1',
      dateiname: 'Prüfung.pdf',
      mime: 'application/pdf',
      groesse: 7,
      sha256: 'ab'.repeat(32),
    });
    const angelegt = h.anlegen.mock.calls[0]![1] as {
      documentData: Record<string, unknown>;
      createdById: string;
    };
    expect(angelegt.documentData).toMatchObject({
      tenantId: G.tenantId,
      clientId: G.clientId,
      ownerStaffId: null,
      mimeType: 'application/pdf',
      classification: 'GENERAL',
    });
    expect(angelegt.documentData['sharedWithClientAt']).toBeInstanceOf(Date);
    expect(angelegt.createdById).toBe(G.contactId);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      G,
      expect.objectContaining({ action: 'document.upload', resourceType: 'document' }),
    );
  });

  it('Typ nicht erlaubt: Abbruch nach dem Prüfen der Bytes, vor jedem Commit', async () => {
    h.erkannt = null;
    await expect(portalAnlageAblegen(G, datei('x.pdf', 'application/pdf'))).rejects.toBeInstanceOf(
      TcmsAnlageAbgelehnt,
    );
    expect(h.schritte).toEqual(['check']);
    expect(h.anlegen).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('Portal-Uploads ausgeschaltet: nichts wird gelesen oder abgelegt', async () => {
    h.upload = false;
    h.erkannt = 'application/pdf';
    await expect(portalAnlageAblegen(G, datei('x.pdf', 'application/pdf'))).rejects.toThrow();
    expect(h.schritte).toEqual([]);
    expect(h.anlegen).not.toHaveBeenCalled();
  });

  it('leere oder zu große Datei: Abbruch vor dem Upload', async () => {
    await expect(portalAnlageAblegen(G, new File([], 'leer.csv'))).rejects.toMatchObject({
      grund: 'LEER',
    });
    await expect(
      portalAnlageAblegen(G, datei('gross.csv', 'text/csv', 10 * MIB + 1)),
    ).rejects.toMatchObject({ grund: 'GROESSE' });
    expect(h.schritte).toEqual([]);
  });
});
