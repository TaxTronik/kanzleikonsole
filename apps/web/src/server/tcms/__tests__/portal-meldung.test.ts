// TCMS s7 (Integration): Anlagen einer Ereignismeldung aus dem Portal sind im
// Tax-CMS Verweise auf Dokumente der kanzleikonsole und werden wie Nachweise
// gebunden (TCMS-NACHWEIS-001). Schutzregeln:
//   - Scheitert eine Datei des Vorgangs, hat die Meldung den Dienst nie
//     erreicht: bereits gebundene Anlagen dieses Vorgangs werden freigegeben.
//   - Annahme der Meldung → Ereignis-ID an allen Anlagen; eindeutige
//     Ablehnung des ersten Versuchs → freigeben („nicht angehängt“); offener
//     Ausgang (Zeitlimit, Transport, 5xx, Protokoll) → Sperre bleibt, der
//     Vorgang wird mit demselben Idempotenzschlüssel wiederholt (kk-tcms-s10nach;
//     Datenbank und Wiederholung: meldevorgang-db.test.ts).
//   - Verwerfen gibt die Anlagen nur nach eindeutiger Antwort frei (dasselbe
//     Ereignis, Status „verworfen“), nur dieses Ereignis dieses Mandanten.
// Fachkatalog: TCMS-NACHWEIS-001
import {
  TcmsKonflikt,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TcmsDienst } from '@/server/tcms/aktion';

const h = vi.hoisted(() => ({
  ablegen: vi.fn(),
  zuordnen: vi.fn(),
  freigeben: vi.fn(),
  beanspruchen: vi.fn(),
  gesendet: vi.fn(),
  wiederholen: vi.fn(),
  nachfuehren: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/auth/rbac', () => ({}));
vi.mock('@/server/actions/audit', () => ({}));
vi.mock('@/server/documents/journaled-upload', () => ({}));
vi.mock('@/server/documents/upload-helpers', () => ({}));
vi.mock('@/server/tcms/portal/anlagen', () => ({ portalAnlageAblegen: h.ablegen }));
vi.mock('@/server/tcms/durchfuehrung/verweis', () => ({
  meldungsAnlagenZuordnen: h.zuordnen,
  meldungsAnlagenFreigeben: h.freigeben,
}));
// Meldevorgang (Datenbank) gemockt; Schlüssel- und Abweichungshelfer echt.
vi.mock('@/server/tcms/portal/meldevorgang', async (original) => ({
  ...(await original<typeof import('@/server/tcms/portal/meldevorgang')>()),
  meldevorgangBeanspruchen: h.beanspruchen,
  meldevorgangGesendet: h.gesendet,
  meldevorgangWiederholen: h.wiederholen,
  nachfuehren: h.nachfuehren,
}));

import {
  meldungErfassen,
  meldungsAnlagenAblegen,
  meldungsAnlagenNachVerwerfen,
} from '../portal/meldung';

const CTX = { tenantId: 't', actorId: 'k', actorType: 'CLIENT_CONTACT' as const };
const ABLAGE = { ctx: CTX, tenantId: 't', contactId: 'k', clientId: 'm' };
const EREIGNIS = 'cmvf9ned0008hdy7dlufu2vuo';
const SCHLUESSEL = 'c0ffee00-0000-4000-8000-00000000a001';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const BODY = {
  typ: 'T-01',
  titel: 'Start auf Kaufland.de',
  beschreibung: 'Ab Dezember verkaufen wir zusätzlich über Kaufland.de.',
  datum: '2026-12-01',
  anlagen: [],
  zusageAenderungen: true,
  benachrichtigen: null,
};

function datei(name: string): File {
  return new File(['a;b\n'], name, { type: 'text/csv' });
}

function dienst(antwort: () => Promise<unknown>) {
  const rufe = vi.fn(async () => ({ daten: await antwort(), requestId: 'r' }));
  return { rufe } as unknown as TcmsDienst & { rufe: typeof rufe };
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  h.ablegen.mockImplementation(async (_g, f: File) => {
    n += 1;
    return {
      verweis: { dokumentId: `d${n}`, dateiname: f.name, mime: 'text/csv', groesse: 4, sha256: '' },
      verknuepfungId: `v${n}`,
    };
  });
  h.zuordnen.mockImplementation(async (_ctx, ids: string[]) => ids.length);
  h.freigeben.mockResolvedValue(1);
});

describe('meldungsAnlagenAblegen', () => {
  it('legt jede Datei ab und sammelt Verweise und Verknüpfungen', async () => {
    const r = await meldungsAnlagenAblegen(ABLAGE, [datei('a.csv'), datei('b.csv')]);
    expect(r.verknuepfungen).toEqual(['v1', 'v2']);
    expect(r.anlagen.map((a) => a.dateiname)).toEqual(['a.csv', 'b.csv']);
    expect(h.ablegen).toHaveBeenCalledWith(ABLAGE, expect.any(File), null);
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('scheitert eine Datei, werden die bereits gebundenen freigegeben (Meldung nie gesendet)', async () => {
    const fehler = new Error('Virenscan');
    h.ablegen
      .mockResolvedValueOnce({ verweis: { dokumentId: 'd1' }, verknuepfungId: 'v1' })
      .mockRejectedValueOnce(fehler);
    await expect(
      meldungsAnlagenAblegen(ABLAGE, [datei('a.csv'), datei('b.csv'), datei('c.csv')]),
    ).rejects.toBe(fehler);
    expect(h.freigeben).toHaveBeenCalledWith(CTX, { verknuepfungIds: ['v1'] }, 'NOT_ATTACHED');
    expect(h.ablegen).toHaveBeenCalledTimes(2);
  });

  it('scheitert auch die Freigabe, bleibt der ursprüngliche Fehler (Sperre bleibt, Protokoll)', async () => {
    const fehler = new Error('Virenscan');
    h.ablegen
      .mockResolvedValueOnce({ verweis: { dokumentId: 'd1' }, verknuepfungId: 'v1' })
      .mockRejectedValueOnce(fehler);
    h.freigeben.mockRejectedValue(new Error('db'));
    await expect(meldungsAnlagenAblegen(ABLAGE, [datei('a.csv'), datei('b.csv')])).rejects.toBe(
      fehler,
    );
    expect(h.log.error).toHaveBeenCalled();
  });
});

describe('meldungErfassen (idempotent, kk-tcms-s10nach)', () => {
  const B = { tenantId: 't', mandantId: 'm', kontaktId: 'k' };
  const VORGANG = { id: 'vorgang-1', schluessel: SCHLUESSEL, token: 'lease-1' };
  const EINGABE = {
    schluessel: SCHLUESSEL,
    dateien: [datei('a.csv'), datei('b.csv')],
    inhalt: {
      typ: BODY.typ,
      titel: BODY.titel,
      beschreibung: BODY.beschreibung,
      datum: BODY.datum,
      zusageAenderungen: true,
      benachrichtigen: null,
    },
  };

  beforeEach(() => {
    h.beanspruchen.mockResolvedValue({ art: 'neu', ...VORGANG });
    h.gesendet.mockResolvedValue(true);
    h.nachfuehren.mockResolvedValue(true);
  });

  it('neu: Vorgang, Ablage mit Schlüssel, Inhalt vor dem Senden, Meldung mit Schlüssel, Ereignis-ID nach Annahme', async () => {
    const d = dienst(async () => ({ id: EREIGNIS, nummer: '2026-T-0400' }));
    const r = await meldungErfassen(d, ABLAGE, EINGABE);
    expect(r).toEqual({ art: 'angenommen', nummer: '2026-T-0400', wiederholung: false });
    expect(h.beanspruchen).toHaveBeenCalledWith(CTX, B, SCHLUESSEL);
    expect(h.ablegen).toHaveBeenCalledWith(ABLAGE, expect.any(File), SCHLUESSEL);
    const inhalt = {
      ...EINGABE.inhalt,
      anlagen: [
        expect.objectContaining({ dokumentId: 'd1' }),
        expect.objectContaining({ dokumentId: 'd2' }),
      ],
    };
    expect(h.gesendet).toHaveBeenCalledWith(CTX, B, { art: 'neu', ...VORGANG }, inhalt);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalMeldungErfassen, {
      body: { ...inhalt, idempotenzSchluessel: SCHLUESSEL },
    });
    // Reihenfolge: Inhalt festgehalten, bevor die Meldung den Dienst erreicht.
    expect(h.gesendet.mock.invocationCallOrder[0]!).toBeLessThan(
      d.rufe.mock.invocationCallOrder[0]!,
    );
    expect(h.nachfuehren).toHaveBeenCalledWith(CTX, B, expect.objectContaining(VORGANG), {
      art: 'angenommen',
      ereignisId: EREIGNIS,
    });
  });

  it('erster Versuch eindeutig abgelehnt (400, 409, offener Breaker): Anlagen frei, Vorgang gelöscht, Fehler weiter', async () => {
    for (const fehler of [
      new TcmsUngueltig({ titel: ['x'] }, { status: 400 }),
      new TcmsKonflikt({ status: 409, konflikt: 'ZWISCHENZEITLICH_GEAENDERT' }),
      new TcmsNichtVerfuegbar('BREAKER'),
    ]) {
      h.nachfuehren.mockClear();
      const d = dienst(async () => {
        throw fehler;
      });
      await expect(meldungErfassen(d, ABLAGE, EINGABE)).rejects.toBe(fehler);
      expect(h.nachfuehren).toHaveBeenCalledWith(CTX, B, expect.objectContaining(VORGANG), {
        art: 'abgelehnt',
      });
    }
  });

  it('IDEMPOTENZ_ABWEICHUNG: ungeklärt (Anlagen bleiben gebunden), Fehler weiter', async () => {
    const fehler = new TcmsKonflikt({ status: 409, konflikt: 'IDEMPOTENZ_ABWEICHUNG' });
    const d = dienst(async () => {
      throw fehler;
    });
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).rejects.toBe(fehler);
    expect(h.nachfuehren).toHaveBeenCalledWith(CTX, B, expect.objectContaining(VORGANG), {
      art: 'ungeklaert',
    });
  });

  it('offener Ausgang (Zeitlimit, Transport, 5xx, Protokoll): Ergebnis „offen“, Vorgang bleibt mit Inhalt', async () => {
    for (const fehler of [
      new TcmsNichtVerfuegbar('ZEITLIMIT'),
      new TcmsNichtVerfuegbar('TRANSPORT'),
      new TcmsNichtVerfuegbar('STATUS', { status: 502 }),
      new TcmsProtokollFehler('SCHEMA'),
    ]) {
      h.nachfuehren.mockClear();
      const d = dienst(async () => {
        throw fehler;
      });
      await expect(meldungErfassen(d, ABLAGE, EINGABE)).resolves.toEqual({ art: 'offen' });
      expect(h.nachfuehren).toHaveBeenCalledWith(CTX, B, expect.objectContaining(VORGANG), {
        art: 'offen',
      });
    }
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('Wiederholung desselben Absendens: gespeicherter Inhalt, keine neue Ablage, kein neuer Inhalt', async () => {
    const gespeichert = { ...EINGABE.inhalt, anlagen: [] };
    h.beanspruchen.mockResolvedValue({ art: 'wiederholung', ...VORGANG, inhalt: gespeichert });
    h.wiederholen.mockResolvedValue({ id: EREIGNIS, nummer: '2026-T-0400' });
    const d = dienst(async () => ({}));
    const r = await meldungErfassen(d, ABLAGE, EINGABE);
    expect(r).toEqual({ art: 'angenommen', nummer: '2026-T-0400', wiederholung: true });
    expect(h.wiederholen).toHaveBeenCalledWith(
      d,
      CTX,
      B,
      expect.objectContaining(VORGANG),
      gespeichert,
    );
    expect(h.ablegen).not.toHaveBeenCalled();
    expect(h.gesendet).not.toHaveBeenCalled();
    // Jede Ablehnung einer Wiederholung lässt den Ausgang offen; nur die Abweichung geht weiter.
    h.wiederholen.mockRejectedValueOnce(new TcmsUngueltig({}, { status: 400 }));
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).resolves.toEqual({ art: 'offen' });
    const abweichung = new TcmsKonflikt({ status: 409, konflikt: 'IDEMPOTENZ_ABWEICHUNG' });
    h.wiederholen.mockRejectedValueOnce(abweichung);
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).rejects.toBe(abweichung);
  });

  it('läuft bzw. abgelaufen: kein Dienstaufruf, keine Ablage', async () => {
    for (const art of ['laeuft', 'abgelaufen'] as const) {
      h.beanspruchen.mockResolvedValueOnce({ art });
      const d = dienst(async () => ({}));
      await expect(meldungErfassen(d, ABLAGE, EINGABE)).resolves.toEqual({ art });
      expect(d.rufe).not.toHaveBeenCalled();
    }
    expect(h.ablegen).not.toHaveBeenCalled();
  });

  it('scheitert die Ablage, wird nie gesendet: Vorgang aufgelöst, Fehler weiter', async () => {
    const fehler = new Error('Virenscan');
    h.ablegen.mockRejectedValueOnce(fehler);
    const d = dienst(async () => ({}));
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).rejects.toBe(fehler);
    expect(h.nachfuehren).toHaveBeenCalledWith(CTX, B, expect.objectContaining(VORGANG), {
      art: 'nieGesendet',
    });
    expect(h.gesendet).not.toHaveBeenCalled();
    expect(d.rufe).not.toHaveBeenCalled();
  });

  it('Lease während der Ablage verloren (RT3C-K-01): nicht gesendet, eigene Anlagen frei, „läuft“', async () => {
    h.gesendet.mockResolvedValueOnce(false);
    const d = dienst(async () => ({ id: EREIGNIS, nummer: '2026-T-0400' }));
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).resolves.toEqual({ art: 'laeuft' });
    expect(d.rufe).not.toHaveBeenCalled();
    expect(h.freigeben).toHaveBeenCalledWith(
      CTX,
      { verknuepfungIds: ['v1', 'v2'] },
      'NOT_ATTACHED',
    );
    expect(h.nachfuehren).not.toHaveBeenCalled();
  });

  it('scheitert das Markieren mit einem Fehler (Ausgang unbekannt), bleibt alles gebunden', async () => {
    const fehler = new Error('Verbindung');
    h.gesendet.mockRejectedValueOnce(fehler);
    const d = dienst(async () => ({}));
    await expect(meldungErfassen(d, ABLAGE, EINGABE)).rejects.toBe(fehler);
    expect(d.rufe).not.toHaveBeenCalled();
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.nachfuehren).not.toHaveBeenCalled();
  });
});

describe('meldungsAnlagenNachVerwerfen', () => {
  const ziel = { mandantId: MANDANT, ereignisId: EREIGNIS };

  it('eindeutige Antwort (dieses Ereignis, verworfen): Anlagen dieses Ereignisses frei', async () => {
    await meldungsAnlagenNachVerwerfen(CTX, ziel, {
      id: EREIGNIS,
      nummer: '2026-T-0345',
      status: 'VERWORFEN',
    });
    expect(h.freigeben).toHaveBeenCalledWith(CTX, ziel, 'DISCARDED');
  });

  it('anderes Ereignis oder anderer Status: Sperre bleibt', async () => {
    await meldungsAnlagenNachVerwerfen(CTX, ziel, {
      id: 'cmvf9anderes0001abcdef',
      nummer: '2026-T-0345',
      status: 'VERWORFEN',
    });
    await meldungsAnlagenNachVerwerfen(CTX, ziel, {
      id: EREIGNIS,
      nummer: '2026-T-0345',
      status: 'IN_TRIAGE',
    });
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it('wirft nie: scheitert die Freigabe, bleibt die Sperre (Protokoll)', async () => {
    h.freigeben.mockRejectedValue(new Error('db'));
    await expect(
      meldungsAnlagenNachVerwerfen(CTX, ziel, {
        id: EREIGNIS,
        nummer: '2026-T-0345',
        status: 'VERWORFEN',
      }),
    ).resolves.toBeUndefined();
    expect(h.log.error).toHaveBeenCalled();
  });
});
