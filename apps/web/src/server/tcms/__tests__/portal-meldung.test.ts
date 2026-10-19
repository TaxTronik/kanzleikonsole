// TCMS s7 (Integration): Anlagen einer Ereignismeldung aus dem Portal sind im
// Tax-CMS Verweise auf Dokumente der kanzleikonsole und werden wie Nachweise
// gebunden (TCMS-NACHWEIS-001). Schutzregeln:
//   - Scheitert eine Datei des Vorgangs, hat die Meldung den Dienst nie
//     erreicht: bereits gebundene Anlagen dieses Vorgangs werden freigegeben.
//   - Annahme der Meldung → Ereignis-ID an allen Anlagen; eindeutige
//     Ablehnung → freigeben („nicht angehängt“); offener Ausgang (Zeitlimit,
//     Transport, 5xx, Protokoll) → Sperre bleibt.
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

import {
  meldungErfassenUndBinden,
  meldungsAnlagenAblegen,
  meldungsAnlagenNachVerwerfen,
} from '../portal/meldung';

const CTX = { tenantId: 't', actorId: 'k', actorType: 'CLIENT_CONTACT' as const };
const ABLAGE = { ctx: CTX, tenantId: 't', contactId: 'k', clientId: 'm' };
const EREIGNIS = 'cmvf9ned0008hdy7dlufu2vuo';
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
    expect(h.ablegen).toHaveBeenCalledWith(ABLAGE, expect.any(File));
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

describe('meldungErfassenUndBinden', () => {
  it('Annahme: Meldung mit dem Body, danach Ereignis-ID an allen Anlagen', async () => {
    const d = dienst(async () => ({ id: EREIGNIS, nummer: '2026-T-0400' }));
    const r = await meldungErfassenUndBinden(d, CTX, BODY, ['v1', 'v2']);
    expect(r).toEqual({ id: EREIGNIS, nummer: '2026-T-0400' });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalMeldungErfassen, { body: BODY });
    expect(h.zuordnen).toHaveBeenCalledWith(CTX, ['v1', 'v2'], EREIGNIS);
    expect(h.zuordnen.mock.invocationCallOrder[0]!).toBeGreaterThan(
      d.rufe.mock.invocationCallOrder[0]!,
    );
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('Zuordnung unvollständig oder gescheitert: Meldung gilt, Sperre bleibt, Protokoll', async () => {
    const d = dienst(async () => ({ id: EREIGNIS, nummer: '2026-T-0400' }));
    h.zuordnen.mockResolvedValueOnce(1);
    await expect(meldungErfassenUndBinden(d, CTX, BODY, ['v1', 'v2'])).resolves.toMatchObject({
      nummer: '2026-T-0400',
    });
    h.zuordnen.mockRejectedValueOnce(new Error('db'));
    await expect(meldungErfassenUndBinden(d, CTX, BODY, ['v1'])).resolves.toMatchObject({
      nummer: '2026-T-0400',
    });
    expect(h.log.error).toHaveBeenCalledTimes(2);
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('eindeutige Ablehnung (400, 409, offener Breaker): Anlagen frei („nicht angehängt“)', async () => {
    for (const fehler of [
      new TcmsUngueltig({ titel: ['x'] }, { status: 400 }),
      new TcmsKonflikt({ status: 409 }),
      new TcmsNichtVerfuegbar('BREAKER'),
    ]) {
      h.freigeben.mockClear();
      const d = dienst(async () => {
        throw fehler;
      });
      await expect(meldungErfassenUndBinden(d, CTX, BODY, ['v1', 'v2'])).rejects.toBe(fehler);
      expect(h.freigeben).toHaveBeenCalledWith(
        CTX,
        { verknuepfungIds: ['v1', 'v2'] },
        'NOT_ATTACHED',
      );
      expect(h.zuordnen).not.toHaveBeenCalled();
    }
  });

  it('offener Ausgang (Zeitlimit, Transport, 5xx, Protokoll): Sperre bleibt', async () => {
    for (const fehler of [
      new TcmsNichtVerfuegbar('ZEITLIMIT'),
      new TcmsNichtVerfuegbar('TRANSPORT'),
      new TcmsNichtVerfuegbar('STATUS', { status: 502 }),
      new TcmsProtokollFehler('SCHEMA'),
    ]) {
      const d = dienst(async () => {
        throw fehler;
      });
      await expect(meldungErfassenUndBinden(d, CTX, BODY, ['v1'])).rejects.toBe(fehler);
    }
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.zuordnen).not.toHaveBeenCalled();
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
