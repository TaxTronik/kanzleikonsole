// TCMS Stufe 3, Bereich C: Bausteine für das Anhängen und Entfernen von
// Nachweisen (server/tcms/durchfuehrung/nachweis-aktion.ts). Die
// Verknüpfungstabelle selbst prüft nachweis-verweis-db.test.ts gegen
// PostgreSQL; hier: Ausgang des Dienstaufrufs → Verknüpfung, Ablage über die
// Dokumentenpipeline, Verweis nur aus der gespeicherten Version; nach dem
// Commit das n8n-Ereignis `document.uploaded` mit Quelle `tcms-nachweis`, ohne
// Titel und ohne Daten des Tax-CMS (kk-tcms-s11 Punkt 5).
// Fachkatalog: TCMS-NACHWEIS-001
import {
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verknuepfenTx: vi.fn(),
  bestaetigen: vi.fn(),
  freigeben: vi.fn(),
  upload: vi.fn(),
  zugriff: vi.fn(),
  audit: vi.fn(),
  dokumentAnlegen: vi.fn(),
  emit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: h.zugriff }));
vi.mock('@/server/actions/audit', () => ({ audit: h.audit }));
vi.mock('@/server/documents/upload-helpers', () => ({
  createDocumentWithVersion: h.dokumentAnlegen,
}));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emit }));
vi.mock('@/server/documents/journaled-upload', async () => {
  class JournaledUploadError extends Error {
    constructor(
      readonly phase: string,
      override readonly cause: unknown,
    ) {
      super('upload');
    }
  }
  return {
    JournaledUploadError,
    runJournaledUpload: h.upload,
    uploadFailureCause: (e: unknown) => (e instanceof JournaledUploadError ? e.cause : e),
  };
});
vi.mock('../verweis', () => ({
  nachweisVerknuepfenTx: h.verknuepfenTx,
  nachweisVerknuepfungBestaetigen: h.bestaetigen,
  nachweisVerknuepfungFreigeben: h.freigeben,
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true })),
}));

import { ActionError } from '@/server/actions/action-error';
import { TcmsInaktivError } from '@/server/tcms/dienst';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import {
  eindeutigAbgelehnt,
  nachweisAnhaengenUndBinden,
  nachweisDateiAblegen,
  nachweisEntfernenUndFreigeben,
  nachweisNichtAngehaengt,
  nachweisVorpruefung,
  vorhandenerNachweis,
} from '../nachweis-aktion';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const STAFF = 'b1000000-0000-4000-8000-000000000002';
const DID = 'cmvf9pzy3003jfu7d4oo44g6s';
const CTX = { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' as const };
const BEZUG = { tenantId: TENANT, mandantId: MANDANT, staffId: STAFF };
const VERKNUEPFT = {
  verknuepfungId: 'f0000000-0000-4000-8000-000000000001',
  verweis: {
    dokumentId: 'c3000000-0000-4000-8000-000000000001',
    dateiname: 'Liste.pdf',
    mime: 'application/pdf',
    groesse: 17,
    sha256: 'a'.repeat(64),
  },
};

function dienst(ergebnis: unknown) {
  return {
    rufe: vi.fn(async () => {
      if (ergebnis instanceof Error) throw ergebnis;
      return { daten: ergebnis, requestId: 'r' };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.bestaetigen.mockResolvedValue(true);
  h.freigeben.mockResolvedValue(1);
});

describe('eindeutigAbgelehnt', () => {
  it('nur sichere Ablehnungen; Zeitlimit, Transport, 5xx und Protokollfehler bleiben offen', () => {
    for (const f of [
      new TcmsUngueltig({}, { status: 400 }),
      new TcmsUngueltig({}, { lokal: true }),
      new TcmsKonflikt({ status: 409 }),
      new TcmsNichtBerechtigt({ status: 403 }),
      new TcmsNichtGefunden({ status: 404 }),
      new TcmsNichtAuthentifiziert({ status: 401 }),
      new TcmsInaktivError(),
      new TcmsNichtVerfuegbar('BREAKER'),
    ]) {
      expect(eindeutigAbgelehnt(f), f.name).toBe(true);
    }
    for (const f of [
      new TcmsNichtVerfuegbar('ZEITLIMIT'),
      new TcmsNichtVerfuegbar('TRANSPORT'),
      new TcmsNichtVerfuegbar('STATUS', { status: 502 }),
      new TcmsNichtVerfuegbar('INTERN'),
      new TcmsProtokollFehler('SCHEMA'),
      new Error('unbekannt'),
    ]) {
      expect(eindeutigAbgelehnt(f), f.name).toBe(false);
    }
  });
});

describe('nachweisAnhaengenUndBinden', () => {
  it('Annahme: Verweis aus der Verknüpfung, Nachweis-ID an die Verknüpfung', async () => {
    const d = dienst({ durchfuehrungId: DID, nachweis: { id: 'cnachweis1' } });
    await nachweisAnhaengenUndBinden(d as never, CTX, DID, VERKNUEPFT);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.nachweisAnhaengen, {
      params: { durchfuehrungId: DID },
      body: { verweis: VERKNUEPFT.verweis },
    });
    expect(h.bestaetigen).toHaveBeenCalledWith(CTX, VERKNUEPFT.verknuepfungId, 'cnachweis1');
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('eindeutige Ablehnung: Verknüpfung „nicht angehängt“ freigeben, Fehler weiter', async () => {
    const fehler = new TcmsKonflikt({ status: 409 });
    await expect(
      nachweisAnhaengenUndBinden(dienst(fehler) as never, CTX, DID, VERKNUEPFT),
    ).rejects.toBe(fehler);
    expect(h.freigeben).toHaveBeenCalledWith(
      CTX,
      { verknuepfungId: VERKNUEPFT.verknuepfungId },
      'NOT_ATTACHED',
    );
  });

  it('offener Ausgang: Verknüpfung bleibt (Sperre), Fehler weiter', async () => {
    const fehler = new TcmsNichtVerfuegbar('ZEITLIMIT');
    await expect(
      nachweisAnhaengenUndBinden(dienst(fehler) as never, CTX, DID, VERKNUEPFT),
    ).rejects.toBe(fehler);
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.bestaetigen).not.toHaveBeenCalled();
  });

  it('Nachweis-ID nicht gesetzt: protokolliert, Ergebnis bleibt', async () => {
    h.bestaetigen.mockRejectedValue(new Error('db'));
    const d = dienst({ durchfuehrungId: DID, nachweis: { id: 'cnachweis1' } });
    await expect(nachweisAnhaengenUndBinden(d as never, CTX, DID, VERKNUEPFT)).resolves.toEqual({
      durchfuehrungId: DID,
      nachweis: { id: 'cnachweis1' },
    });
    expect(h.log.error).toHaveBeenCalled();
  });
});

describe('nachweisEntfernenUndFreigeben', () => {
  const ziel = { mandantId: MANDANT, durchfuehrungId: DID, nachweisId: 'cnachweis1' };

  it('erst Entfernen im Tax-CMS, dann Freigabe „entfernt“', async () => {
    const d = dienst({ durchfuehrungId: DID, nachweisId: 'cnachweis1' });
    await nachweisEntfernenUndFreigeben(d as never, CTX, ziel);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.nachweisEntfernen, {
      params: { durchfuehrungId: DID, nachweisId: 'cnachweis1' },
    });
    expect(h.freigeben).toHaveBeenCalledWith(CTX, ziel, 'REMOVED');
  });

  it('Entfernen abgelehnt: keine Freigabe (Sperre bleibt)', async () => {
    const fehler = new TcmsNichtBerechtigt({ status: 403 });
    await expect(nachweisEntfernenUndFreigeben(dienst(fehler) as never, CTX, ziel)).rejects.toBe(
      fehler,
    );
    expect(h.freigeben).not.toHaveBeenCalled();
  });
});

describe('Vorprüfung und gleicher Inhalt', () => {
  it('ohne Recht keine Ablage: Grund des Dienstes bzw. fester Text', async () => {
    const d = tcmsFixtures.durchfuehrungGegenzeichnung();
    d.rechte.bearbeiten = {
      erlaubt: false,
      grund: 'Einreichung liegt vor — keine Änderung mehr möglich',
      verweigerung: null,
    };
    await expect(nachweisVorpruefung(dienst(d) as never, DID)).rejects.toThrow(
      'Upload nicht möglich: Einreichung liegt vor — keine Änderung mehr möglich',
    );
    d.rechte.bearbeiten = { erlaubt: false, grund: null, verweigerung: null };
    await expect(nachweisVorpruefung(dienst(d) as never, DID)).rejects.toThrow(
      TCMS_KEIN_RECHT.DURCHFUEHREN,
    );
    // TCMS s6: Verweigerung der Person → fester Text zum Grund (wie beim 403), nie der Text des Dienstes.
    d.rechte.bearbeiten = {
      erlaubt: false,
      grund: 'Diese Kontrolle führt der Mandant im Portal durch',
      verweigerung: 'PARTEI',
    };
    await expect(nachweisVorpruefung(dienst(d) as never, DID)).rejects.toThrow(
      TCMS_KEIN_RECHT.PARTEI,
    );
    d.rechte.bearbeiten = { erlaubt: true, grund: null, verweigerung: null };
    await expect(nachweisVorpruefung(dienst(d) as never, DID)).resolves.toBe(d);
  });

  it('erkennt gleichen Inhalt (SHA-256) und gleiches Dokument', () => {
    const d = tcmsFixtures.durchfuehrungInDurchfuehrung();
    expect(vorhandenerNachweis(d, { sha256: 'a'.repeat(64) })).toBe(
      'Kontoabstimmung September.pdf',
    );
    expect(vorhandenerNachweis(d, { dokumentId: 'C3000000-0000-4000-8000-000000000001' })).toBe(
      'Kontoabstimmung September.pdf',
    );
    expect(vorhandenerNachweis(d, { sha256: 'b'.repeat(64) })).toBeNull();
  });
});

describe('nachweisDateiAblegen', () => {
  const G = { ctx: CTX, session: { user: {} }, tenantId: TENANT, staffId: STAFF };
  const DATEI = {
    bytes: Buffer.from('%PDF-1.4'),
    fileName: 'C:\\temp\\Liste.pdf',
    mimeType: 'application/pdf',
  };

  function optionen() {
    expect(h.upload).toHaveBeenCalledOnce();
    return h.upload.mock.calls[0]![0] as {
      context: unknown;
      source: string;
      check: (tx: unknown, phase: string, vorher?: unknown) => Promise<unknown>;
      readBytes: () => Promise<Buffer>;
      storage: (c: unknown) => unknown;
      commitTx: (tx: unknown, i: { commit: unknown; checked: unknown }) => Promise<unknown>;
    };
  }

  it('Dokumentenpipeline am Mandanten; Dokument, Audit und Verknüpfung in derselben Commit-Transaktion', async () => {
    h.upload.mockImplementation(async () => ({
      result: { verknuepfungId: 'v', dokumentId: 'neu' },
    }));
    await nachweisDateiAblegen(G as never, BEZUG, DID, DATEI);
    const o = optionen();
    expect(o.context).toBe(CTX);
    expect(o.source).toBe('staff.tcms.nachweis');
    await expect(o.readBytes()).resolves.toBe(DATEI.bytes);
    expect(o.storage({ tier: 'NONE', typeId: 't', retentionYears: null })).toEqual({
      tier: 'NONE',
      classification: 'GENERAL',
    });

    h.dokumentAnlegen.mockResolvedValue({
      document: { id: 'd0000000-0000-4000-8000-000000000001' },
    });
    h.verknuepfenTx.mockResolvedValue({ verknuepfungId: 'v', verweis: { dokumentId: 'x' } });
    const commit = {
      detectedMime: 'application/pdf',
      sha256: Buffer.alloc(32, 1),
      immutable: false,
      retentionUntil: null,
    };
    const tx = { tx: 'commit' };
    await expect(
      o.commitTx(tx, { commit, checked: { tier: 'NONE', typeId: 't', retentionYears: null } }),
    ).resolves.toEqual({
      verknuepfungId: 'v',
      verweis: { dokumentId: 'x' },
      dokumentId: 'd0000000-0000-4000-8000-000000000001',
    });
    const anlage = h.dokumentAnlegen.mock.calls[0]![1] as { documentData: Record<string, unknown> };
    expect(anlage.documentData).toMatchObject({
      tenantId: TENANT,
      clientId: MANDANT,
      title: 'Liste.pdf',
      classification: 'GENERAL',
      documentTypeId: 't',
      mimeType: 'application/pdf',
    });
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      G,
      expect.objectContaining({
        action: 'document.upload',
        resourceId: 'd0000000-0000-4000-8000-000000000001',
      }),
    );
    // Verweis nur aus dem gespeicherten Dokument (verweis.ts), in derselben Transaktion.
    expect(h.verknuepfenTx).toHaveBeenCalledWith(
      tx,
      BEZUG,
      'd0000000-0000-4000-8000-000000000001',
      DID,
    );
  });

  it('kk-tcms-s11: nach dem Commit `document.uploaded` mit Quelle tcms-nachweis, ohne Titel und Tax-CMS-Daten', async () => {
    h.upload.mockResolvedValue({ result: { verknuepfungId: 'v', dokumentId: 'neu' } });
    await expect(nachweisDateiAblegen(G as never, BEZUG, DID, DATEI)).resolves.toEqual({
      verknuepfungId: 'v',
      dokumentId: 'neu',
    });
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.emit).toHaveBeenCalledWith(
      'document.uploaded',
      {
        tenantId: TENANT,
        documentId: 'neu',
        classification: 'GENERAL',
        clientId: MANDANT,
        isGobd: false,
        source: 'tcms-nachweis',
      },
      { tenantId: TENANT, dedupeKey: 'document.uploaded:neu' },
    );
    const nutzlast = JSON.stringify(h.emit.mock.calls[0]);
    expect(nutzlast).not.toContain('Liste');
    expect(nutzlast).not.toContain(DID);
    // Erst nach dem Commit: Die Pipeline ist vollständig durchlaufen.
    expect(h.upload.mock.invocationCallOrder[0]).toBeLessThan(h.emit.mock.invocationCallOrder[0]!);
  });

  it('kk-tcms-s11: gescheiterter Upload löst kein Ereignis aus', async () => {
    h.upload.mockRejectedValue(new ActionError('Die Datei wurde vom Virenscanner abgewiesen.'));
    await expect(nachweisDateiAblegen(G as never, BEZUG, DID, DATEI)).rejects.toThrow(
      /Virenscanner/,
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('Vorprüfung: Mandant nur mit Zugriff der kanzleikonsole; Typänderung zwischen Vor- und Nachprüfung', async () => {
    h.upload.mockResolvedValue({ result: {} });
    await nachweisDateiAblegen(G as never, BEZUG, DID, DATEI);
    const o = optionen();
    const tx = {
      client: { findFirst: vi.fn(async () => ({ id: MANDANT })) },
      documentType: {
        findFirst: vi.fn(async () => ({ id: 't', tier: 'NONE', retentionYears: null })),
      },
    };
    h.zugriff.mockResolvedValue(false);
    await expect(o.check(tx, 'pre')).rejects.toThrow('Mandant nicht gefunden.');
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: MANDANT, tenantId: TENANT },
      select: { id: true },
    });
    h.zugriff.mockResolvedValue(true);
    const vorher = await o.check(tx, 'pre');
    expect(vorher).toEqual({ tier: 'NONE', typeId: 't', retentionYears: null });
    tx.documentType.findFirst.mockResolvedValue({
      id: 't',
      tier: 'GOBD',
      retentionYears: 10,
    } as never);
    await expect(o.check(tx, 'post', vorher)).rejects.toThrow(/Dokumenttyp wurde während/);
  });

  it('Fehler der Pipeline kommen als ursprünglicher Fehler (Virenscan, Größe) zurück', async () => {
    const { JournaledUploadError } = await import('@/server/documents/journaled-upload');
    const ursache = new ActionError('Die Datei wurde vom Virenscanner abgewiesen.');
    h.upload.mockRejectedValue(new JournaledUploadError('prepare', ursache));
    await expect(nachweisDateiAblegen(G as never, BEZUG, DID, DATEI)).rejects.toBe(ursache);
  });
});

describe('nachweisNichtAngehaengt', () => {
  it('Hinweis auf die Ablage plus fester Text, nie der Text des Dienstes', () => {
    const fehler = new TcmsNichtBerechtigt({ status: 403, meldung: 'Vier-Augen: Anna Roth hat …' });
    const e = nachweisNichtAngehaengt(fehler, 'nachweisAnhaengen');
    expect(e).toBeInstanceOf(ActionError);
    expect(e.message).toBe(
      `Die Datei wurde in der Dokumentablage des Mandanten gespeichert, aber nicht als Nachweis angehängt. ${TCMS_KEIN_RECHT.DURCHFUEHREN}`,
    );
    expect(e.message).not.toContain('Anna');
  });
});
