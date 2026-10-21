// TCMS Stufe 3, Bereich D: Anlagen aus dem Mandantenportal. Die kanzleikonsole
// nimmt Dateien über ihre Portal-Dokumentenpipeline an; das Tax-CMS erhält nur
// einen Verweis aus der GESPEICHERTEN Fassung. Schutzregeln:
//   - Dateityp nach Inhalt (Magic Bytes) auf der Positivliste des Vertrags;
//     eine als PDF gemeldete Datei ohne Signatur wird abgewiesen.
//   - Portal-Funktion „Dokumente hochladen“ muss an sein.
//   - Verweis (ID, Typ, Größe, SHA-256) aus dem Commit, nie aus Formularangaben.
//   - Grenzen je Datei, Anzahl und zusammen (Body-Limit der Server-Actions).
//   - Anlagen einer Kontrollaufgabe werden in DERSELBEN Commit-Transaktion als
//     Nachweis der Durchführung verknüpft (Löschsperre, TCMS-NACHWEIS-001);
//     der Verweis kommt dann aus der Verknüpfung (gespeicherte Version).
//   - Anlagen einer Ereignismeldung (TCMS s7) werden ebenso in DERSELBEN
//     Commit-Transaktion gebunden (Bezug „Ereignis“, Kontakt als Urheber).
//   - kk-tcms-s11 Punkt 5: nach dem Commit das n8n-Ereignis `document.uploaded`
//     wie jeder Portal-Upload, Quelle `tcms-nachweis` bzw. `tcms-meldung`, ohne
//     Dateiname und ohne Daten des Tax-CMS; ohne Ablage kein Ereignis.
// Fachkatalog: TCMS-DIENST-001, TCMS-NACHWEIS-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMMIT_TX = vi.hoisted(() => ({ commitTx: true }));
const h = vi.hoisted(() => ({
  erkannt: null as string | null,
  upload: true,
  audit: vi.fn(),
  anlegen: vi.fn(),
  limit: vi.fn(),
  verknuepfen: vi.fn(),
  meldungsAnlage: vi.fn(),
  emit: vi.fn(),
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
vi.mock('@/server/n8n/emit', () => ({
  emitN8nEvent: vi.fn(async (...a: unknown[]) => {
    h.schritte.push('ereignis');
    return h.emit(...a);
  }),
}));
vi.mock('@/server/tcms/durchfuehrung/verweis', () => ({
  nachweisVerknuepfenTx: h.verknuepfen,
  meldungsAnlageVerknuepfenTx: h.meldungsAnlage,
}));
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
    const result = await o.commitTx(COMMIT_TX, { commit });
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
  portalNachweisAblegen,
  TcmsAnlageAbgelehnt,
} from '../portal/anlagen';
import { SERVER_ACTION_BODY_LIMIT_BYTES } from '@/lib/upload-limits.mjs';
import { DATEINAME_UNZULAESSIG } from '@taxtronik/tcms-contract';

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
  h.meldungsAnlage.mockImplementation(async () => {
    h.schritte.push('binden');
    return 'e2000000-0000-4000-8000-0000000000b2';
  });
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

  it('Zeichenregel des Vertrags (TCMS s8): auch Variantenselektoren, Tag-Zeichen, Anführungszeichen', () => {
    const roh = `Beleg${String.fromCodePoint(0x2764, 0xfe0f, 0x034f, 0x180b, 0xe0041)}"Q3"${String.fromCodePoint(0x200e)}.pdf`;
    const name = portalDateiname(roh);
    expect(name).toBe(`Beleg${String.fromCodePoint(0x2764)}Q3.pdf`);
    expect(DATEINAME_UNZULAESSIG.test(name)).toBe(false);
    expect(portalDateiname(`${String.fromCodePoint(0x200b)}\n`)).toBe('Anlage');
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

const SCHLUESSEL = '3f2b8c1d-6e4a-4b7f-9a0c-1d2e3f4a5b6c';

describe('n8n-Ereignis nach der Ablage (kk-tcms-s11)', () => {
  const DOK = 'd0c00000-0000-4000-8000-0000000000a1';
  const erwartet = (quelle: string) => [
    'document.uploaded',
    {
      tenantId: G.tenantId,
      documentId: DOK,
      classification: 'GENERAL',
      clientId: G.clientId,
      isGobd: false,
      source: quelle,
    },
    { tenantId: G.tenantId, dedupeKey: `document.uploaded:${DOK}` },
  ];

  it('Anlage einer Ereignismeldung: Quelle tcms-meldung, nach dem Commit, ohne Dateiname', async () => {
    h.erkannt = 'application/pdf';
    await portalAnlageAblegen(G, datei('Kasse Oktober.pdf', 'application/pdf'), 'k');
    expect(h.emit.mock.calls).toEqual([erwartet('tcms-meldung')]);
    expect(h.schritte.slice(-2)).toEqual(['commit', 'ereignis']);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain('Kasse');
  });

  it('Anlage einer Kontrollaufgabe: Quelle tcms-nachweis, ohne Durchführungs-ID', async () => {
    h.erkannt = 'application/pdf';
    h.verknuepfen.mockResolvedValue({ verknuepfungId: 'v', verweis: { dokumentId: DOK } });
    const did = 'cmvf9ne7i007kdy7d467junj7';
    await portalNachweisAblegen(G, datei('Beleg.pdf', 'application/pdf'), did);
    expect(h.emit.mock.calls).toEqual([erwartet('tcms-nachweis')]);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(did);
  });

  it('ohne Ablage (Typ abgewiesen, Bindung gescheitert) kein Ereignis', async () => {
    h.erkannt = 'application/x-msdownload';
    await expect(portalAnlageAblegen(G, datei('x.pdf', 'application/pdf'))).rejects.toThrow();
    h.erkannt = 'application/pdf';
    h.meldungsAnlage.mockRejectedValueOnce(new Error('Bindung'));
    await expect(portalAnlageAblegen(G, datei('x.pdf', 'application/pdf'))).rejects.toThrow(
      'Bindung',
    );
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('portalAnlageAblegen', () => {
  it('Verweis aus der gespeicherten Fassung; Dokument am Sitzungsmandanten, geteilt, auditiert', async () => {
    h.erkannt = 'application/pdf';
    // Browser meldet etwas anderes als den Inhalt: es zählt der erkannte Typ.
    const { verweis, verknuepfungId } = await portalAnlageAblegen(
      G,
      datei('C:\\tmp\\Prüfung.pdf', 'text/plain', 7),
      SCHLUESSEL,
    );
    expect(verweis).toEqual({
      dokumentId: 'd0c00000-0000-4000-8000-0000000000a1',
      dateiname: 'Prüfung.pdf',
      mime: 'application/pdf',
      groesse: 7,
      sha256: 'ab'.repeat(32),
    });
    expect(verknuepfungId).toBe('e2000000-0000-4000-8000-0000000000b2');
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
    // Anlage einer Meldung (TCMS s7): gebunden in derselben Commit-Transaktion,
    // Bezug „Ereignis“, Kontakt als Urheber – nie als Nachweis einer Durchführung.
    expect(h.verknuepfen).not.toHaveBeenCalled();
    expect(h.meldungsAnlage).toHaveBeenCalledWith(
      COMMIT_TX,
      { tenantId: G.tenantId, mandantId: G.clientId, kontaktId: G.contactId },
      'd0c00000-0000-4000-8000-0000000000a1',
      // Idempotenzschlüssel des Meldevorgangs an der Anlage (kk-tcms-s10nach).
      SCHLUESSEL,
    );
    expect(h.schritte).toEqual(['check', 'prepare', 'binden', 'commit', 'ereignis']);
    expect(h.audit.mock.invocationCallOrder[0]!).toBeLessThan(
      h.meldungsAnlage.mock.invocationCallOrder[0]!,
    );
  });

  it('Ereignismeldung: scheitert die Bindung, scheitert der Commit (keine ungebundene Ablage)', async () => {
    h.erkannt = 'application/pdf';
    const fehler = new Error('tcms_document_reference: Dokument dieses Mandanten nicht verfügbar');
    h.meldungsAnlage.mockRejectedValue(fehler);
    await expect(portalAnlageAblegen(G, datei('x.pdf', 'application/pdf'))).rejects.toBe(fehler);
    expect(h.schritte).toEqual(['check', 'prepare']);
  });

  it('Kontrollaufgabe: Verknüpfung in derselben Commit-Transaktion, Kontakt als Urheber', async () => {
    h.erkannt = 'application/pdf';
    const verknuepft = {
      verknuepfungId: 'e1000000-0000-4000-8000-0000000000a1',
      verweis: {
        dokumentId: 'd0c00000-0000-4000-8000-0000000000a1',
        dateiname: 'Prüfung.pdf',
        mime: 'application/pdf',
        groesse: 7,
        sha256: 'ab'.repeat(32),
      },
    };
    h.verknuepfen.mockImplementation(async () => {
      h.schritte.push('verknuepfen');
      return verknuepft;
    });
    const r = await portalNachweisAblegen(
      G,
      datei('Prüfung.pdf', 'application/pdf', 7),
      'cmvf9ne7i007kdy7d467junj7',
    );
    expect(r).toBe(verknuepft);
    expect(h.verknuepfen).toHaveBeenCalledWith(
      COMMIT_TX,
      { tenantId: G.tenantId, mandantId: G.clientId, kontaktId: G.contactId },
      'd0c00000-0000-4000-8000-0000000000a1',
      'cmvf9ne7i007kdy7d467junj7',
    );
    // Verknüpft wird innerhalb des Commits (vor dessen Abschluss), nach dem Audit.
    expect(h.schritte).toEqual(['check', 'prepare', 'verknuepfen', 'commit', 'ereignis']);
    expect(h.audit.mock.invocationCallOrder[0]!).toBeLessThan(
      h.verknuepfen.mock.invocationCallOrder[0]!,
    );
  });

  it('Kontrollaufgabe: scheitert die Verknüpfung, scheitert der Commit (keine unverknüpfte Ablage)', async () => {
    h.erkannt = 'application/pdf';
    const fehler = new Error('tcms_document_reference: Dokument dieses Mandanten nicht verfügbar');
    h.verknuepfen.mockRejectedValue(fehler);
    await expect(
      portalNachweisAblegen(G, datei('x.pdf', 'application/pdf'), 'cmvf9ne7i007kdy7d467junj7'),
    ).rejects.toBe(fehler);
    expect(h.schritte).toEqual(['check', 'prepare']);
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
