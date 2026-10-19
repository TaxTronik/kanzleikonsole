// TCMS s7, TCMS-NACHWEIS-001: Abgleich offener Nachweis-Verknüpfungen
// (unklarer Ausgang beim Anhängen) über „Nachweise je Dokument“. Bestätigen
// nur, wenn der Dienst einen aktiven, noch nicht gebundenen Nachweis dieser
// Durchführung führt; freigeben nur nach eindeutiger Antwort; jeder Lesefehler
// lässt die Verknüpfung offen. Die Abfrage gegen PostgreSQL belegt
// nachweis-verweis-db.test.ts.
// Fachkatalog: TCMS-NACHWEIS-001
import { NachweiseJeDokumentSchema } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tenantLesen: vi.fn(),
  lesenOptional: vi.fn(),
  bestaetigen: vi.fn(),
  freigeben: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('@/server/tcms/seite', () => ({
  tcmsTenantLesen: h.tenantLesen,
  tcmsLesenOptional: h.lesenOptional,
}));
vi.mock('../verweis', () => ({
  nachweisVerknuepfungBestaetigen: h.bestaetigen,
  nachweisVerknuepfungFreigeben: h.freigeben,
}));

import {
  ABGLEICH_MAX_JE_AUFRUF,
  ABGLEICH_MIN_ALTER_MS,
  abgleichEntscheidung,
  offeneNachweiseAbgleichen,
  offeneVerknuepfungenTx,
} from '../abgleich';

const DOK = 'd0c00000-0000-4000-8000-0000000000a1';
const DOK2 = 'd0c00000-0000-4000-8000-0000000000a2';
const DF = 'cmvf9pzy3003jfu7d4oo44g6s';
const ANDERE_DF = 'cmvf9q01f004tfu7dl6bhs0my';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const STAFF = 'b1000000-0000-4000-8000-000000000001';
const SEITE = {
  ok: true,
  art: 'MANDANT',
  mandantId: MANDANT,
  session: { user: { tenantId: TENANT, staffId: STAFF } },
} as never;

const v = (id: string, documentId = DOK) => ({ id, documentId, tcmsExecutionId: DF });
const antwort = (
  nachweise: Array<{ id: string; durchfuehrungId: string; entfernt: boolean }>,
  dokumentId = DOK,
) => NachweiseJeDokumentSchema.parse({ dokumentId, nachweise });

describe('abgleichEntscheidung', () => {
  it('aktiver Nachweis dieser Durchführung → bestätigen (kleinste freie ID)', () => {
    expect(
      abgleichEntscheidung(
        v('r1'),
        antwort([
          { id: 'nzz', durchfuehrungId: DF, entfernt: false },
          { id: 'naa', durchfuehrungId: DF, entfernt: false },
        ]),
        new Set(),
      ),
    ).toEqual({ art: 'BESTAETIGEN', nachweisId: 'naa' });
  });

  it('nur entfernt → freigeben „REMOVED“; keiner für diese Durchführung → „NOT_ATTACHED“', () => {
    expect(
      abgleichEntscheidung(
        v('r1'),
        antwort([{ id: 'n1', durchfuehrungId: DF, entfernt: true }]),
        new Set(),
      ),
    ).toEqual({ art: 'FREIGEBEN', grund: 'REMOVED' });
    expect(
      abgleichEntscheidung(
        v('r1'),
        antwort([{ id: 'n1', durchfuehrungId: ANDERE_DF, entfernt: false }]),
        new Set(),
      ),
    ).toEqual({ art: 'FREIGEBEN', grund: 'NOT_ATTACHED' });
    expect(abgleichEntscheidung(v('r1'), antwort([]), new Set())).toEqual({
      art: 'FREIGEBEN',
      grund: 'NOT_ATTACHED',
    });
  });

  it('Nachweis schon an einer anderen offenen Verknüpfung → diese freigeben (Dublette)', () => {
    expect(
      abgleichEntscheidung(
        v('r2'),
        antwort([{ id: 'n1', durchfuehrungId: DF, entfernt: false }]),
        new Set(['n1']),
      ),
    ).toEqual({ art: 'FREIGEBEN', grund: 'NOT_ATTACHED' });
  });

  it('Antwort zu einem anderen Dokument: keine Entscheidung', () => {
    expect(abgleichEntscheidung(v('r1'), antwort([], DOK2), new Set())).toBeNull();
  });
});

describe('offeneVerknuepfungenTx', () => {
  it('nur offene ohne Nachweis-ID dieser Durchführung, älter als die Grenze, begrenzt; gebundene IDs je Dokument', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'r1', documentId: DOK },
        { id: 'r2', documentId: DOK2 },
      ])
      .mockResolvedValueOnce([{ tcmsEvidenceId: 'n9' }]);
    const tx = { tcmsDocumentReference: { findMany } } as never;
    const bis = new Date('2026-10-19T10:00:00Z');
    const r = await offeneVerknuepfungenTx(tx, { tenantId: TENANT, mandantId: MANDANT }, DF, bis);
    expect(findMany.mock.calls[0]![0]).toEqual({
      where: {
        tenantId: TENANT,
        clientId: MANDANT,
        tcmsSubject: 'EXECUTION',
        tcmsExecutionId: DF,
        releasedAt: null,
        tcmsEvidenceId: null,
        createdAt: { lt: bis },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ABGLEICH_MAX_JE_AUFRUF,
      select: { id: true, documentId: true },
    });
    expect(r.offen).toEqual([v('r1'), v('r2', DOK2)]);
    expect(findMany.mock.calls[1]![0].where).toEqual({
      tenantId: TENANT,
      clientId: MANDANT,
      documentId: { in: [DOK, DOK2] },
      releasedAt: null,
      tcmsEvidenceId: { not: null },
    });
    expect(r.gebunden).toEqual(new Set(['n9']));
  });
});

describe('offeneNachweiseAbgleichen', () => {
  const jetzt = new Date('2026-10-19T12:00:00Z');

  function offen(liste: ReturnType<typeof v>[], gebunden: string[] = []) {
    h.tenantLesen.mockImplementation(async (_s: unknown, fn: (tx: unknown) => unknown) => {
      const findMany = vi
        .fn()
        .mockResolvedValueOnce(liste)
        .mockResolvedValueOnce(gebunden.map((tcmsEvidenceId) => ({ tcmsEvidenceId })));
      return fn({ tcmsDocumentReference: { findMany } });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.bestaetigen.mockResolvedValue(true);
    h.freigeben.mockResolvedValue(1);
  });

  it('liest je Dokument einmal, bestätigt bzw. gibt frei, Kontext der Kanzleiperson', async () => {
    offen([v('r1'), v('r2'), v('r3', DOK2)]);
    h.lesenOptional.mockImplementation(
      async (_s: unknown, _e: unknown, e: { query: { dokumentId: string } }) => ({
        ok: true,
        daten:
          e.query.dokumentId === DOK
            ? antwort([{ id: 'n1', durchfuehrungId: DF, entfernt: false }])
            : antwort([{ id: 'n7', durchfuehrungId: DF, entfernt: true }], DOK2),
        requestId: 'r',
      }),
    );
    const r = await offeneNachweiseAbgleichen(SEITE, DF, jetzt);
    expect(r).toEqual({ bestaetigt: 1, freigegeben: 2, offen: 0 });
    expect(h.lesenOptional).toHaveBeenCalledTimes(2);
    expect(h.lesenOptional.mock.calls[0]![1]).toMatchObject({ name: 'nachweiseJeDokumentLesen' });
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { dokumentId: DOK } });
    const ctx = { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' };
    expect(h.bestaetigen).toHaveBeenCalledWith(ctx, 'r1', 'n1');
    // r2: derselbe Nachweis ist jetzt gebunden → Dublette freigeben.
    expect(h.freigeben).toHaveBeenCalledWith(ctx, { verknuepfungId: 'r2' }, 'NOT_ATTACHED');
    expect(h.freigeben).toHaveBeenCalledWith(ctx, { verknuepfungId: 'r3' }, 'REMOVED');
    // Grenze: nur Verknüpfungen, die älter als das Mindestalter sind.
    const tx = h.tenantLesen.mock.calls[0]![1];
    expect(typeof tx).toBe('function');
  });

  it('Mindestalter: Grenze = jetzt − ABGLEICH_MIN_ALTER_MS', async () => {
    let bis: Date | null = null;
    h.tenantLesen.mockImplementation(async (_s: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        tcmsDocumentReference: {
          findMany: vi.fn(async (a: { where: { createdAt?: { lt: Date } } }) => {
            bis ??= a.where.createdAt?.lt ?? null;
            return [];
          }),
        },
      }),
    );
    await offeneNachweiseAbgleichen(SEITE, DF, jetzt);
    expect(bis!.getTime()).toBe(jetzt.getTime() - ABGLEICH_MIN_ALTER_MS);
    expect(h.lesenOptional).not.toHaveBeenCalled();
  });

  it('Lesefehler (Zustand) oder unbekannter Mandant: nichts ändern, später erneut', async () => {
    offen([v('r1'), v('r2', DOK2)]);
    h.lesenOptional
      .mockResolvedValueOnce({ ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: null } })
      .mockResolvedValueOnce({ ok: true, daten: null, requestId: 'r' });
    const r = await offeneNachweiseAbgleichen(SEITE, DF, jetzt);
    expect(r).toEqual({ bestaetigt: 0, freigegeben: 0, offen: 2 });
    expect(h.bestaetigen).not.toHaveBeenCalled();
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('wirft nie: Fehler der Datenbank → unverändert, Protokoll ohne Inhalte', async () => {
    h.tenantLesen.mockRejectedValue(new Error('verbindung weg 4711'));
    await expect(offeneNachweiseAbgleichen(SEITE, DF, jetzt)).resolves.toEqual({
      bestaetigt: 0,
      freigegeben: 0,
      offen: 0,
    });
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('4711');
  });
});
