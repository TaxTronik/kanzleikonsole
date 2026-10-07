// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Review-Befund K-05: Die Fristen-Seite blättert getrennt in den offenen und in
// den erledigten Einträgen („Mit Erledigten“). Alle Seiten zusammen müssen genau
// die offenen bzw. erledigten Einträge der vollständigen Sicht in derselben
// Reihenfolge ergeben, die Zählwerte müssen ihr entsprechen und die abgeleiteten
// Tagesabschluss-Zähler denen von prepareDailyReview über den vollständigen
// Abschluss-Loader. Geprüft mit Speicher-Adaptern über zufällige Bestände,
// einschließlich Zeilen, deren Zustand erst toEintrag entscheidet (verspätete
// Einlegung: offener Zweig, aber erledigt; Rückschau-Vorbehalt, aber offen).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FristEintrag } from '../eintrag';
import type { KontrollbuchQuelle, QuellFilter } from '../quellen/typen';

const HEUTE = new Date('2026-07-16T00:00:00.000Z');
const TAG = 86_400_000;

type Teil = 'offen' | 'vorbehalt' | 'erledigt' | 'erledigtVorbehalt';
interface Zeile {
  id: string;
  clientId: string;
  faelligAm: Date;
  teil: Teil;
  erledigt: boolean;
}
interface Filter {
  teil: Teil | 'fenster';
  nurOffene: boolean;
  horizont: number;
  rueckschau: number;
}

const bestand = vi.hoisted(() => ({
  quellen: [] as Array<KontrollbuchQuelle<unknown, unknown>>,
}));

vi.mock('../quellen', () => ({
  get KONTROLLBUCH_QUELLEN() {
    return bestand.quellen;
  },
}));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: async () => ({}) }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import { loadKontrollbuch, loadKontrollbuchSeite } from '../kontrollbuch';
import { loadDailyReviewPreview, prepareDailyReview } from '../tagesabschluss';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speicherQuelle(
  rang: number,
  zeilen: Zeile[],
  aktiv: (q: { taxNotices: boolean; reminders: boolean }) => boolean = () => true,
): KontrollbuchQuelle<Zeile, Filter> {
  // Wie die echten Adapter: offen ohne untere Grenze bis zum Horizont, der
  // Rückschau-Zweig nur im Fenster [Rückschau, Horizont].
  const rueckschauZweig = (z: Zeile) => z.teil === 'erledigt' || z.teil === 'erledigtVorbehalt';
  const imFenster = (z: Zeile, f: Filter) => {
    const t = z.faelligAm.getTime();
    return t <= f.horizont && (!rueckschauZweig(z) || t >= f.rueckschau);
  };
  const teil = (f: Filter) =>
    zeilen.filter(
      (z) =>
        imFenster(z, f) &&
        (f.teil === 'fenster' ? !rueckschauZweig(z) || !f.nurOffene : z.teil === f.teil),
    );
  return {
    rang,
    aktiv,
    where(k): QuellFilter<Filter> {
      const f = (t: Filter['teil']): Filter => ({
        teil: t,
        nurOffene: k.nurOffene,
        horizont: k.horizont.getTime(),
        rueckschau: k.rueckschau.getTime(),
      });
      return {
        fenster: f('fenster'),
        offen: f('offen'),
        offenVorbehalt: zeilen.some((z) => z.teil === 'vorbehalt') ? f('vorbehalt') : null,
        erledigt: k.nurOffene ? null : f('erledigt'),
        erledigtVorbehalt:
          k.nurOffene || !zeilen.some((z) => z.teil === 'erledigtVorbehalt')
            ? null
            : f('erledigtVorbehalt'),
      };
    },
    async query(_tx, where, seite) {
      const rows = teil(where);
      if (!seite) return [...rows].reverse(); // DB-Reihenfolge ohne ORDER BY: beliebig
      // Fälligkeit in Seitenrichtung, Gleichstände nach ID aufsteigend.
      const richtung = seite.absteigend ? -1 : 1;
      return [...rows]
        .sort(
          (a, b) =>
            richtung * (a.faelligAm.getTime() - b.faelligAm.getTime()) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, seite.take);
    },
    async count(_tx, where, faellig) {
      return teil(where).filter((z) => {
        if (!faellig) return true;
        const t = z.faelligAm.getTime();
        return 'lt' in faellig ? t < faellig.lt.getTime() : t <= faellig.lte.getTime();
      }).length;
    },
    bezug: (z) => ({ clientId: z.clientId, staffIds: [] }),
    toEintrag(z, personen): FristEintrag {
      const verantwortlichId = personen.hauptbearbeiter(z.clientId);
      return {
        quelle: 'ANFORDERUNG',
        kontrollart: 'OPERATIONAL_DUE_DATE',
        id: z.id,
        titel: `${rang}/${z.id}`,
        clientId: z.clientId,
        clientName: z.clientId,
        faelligAm: z.faelligAm,
        erledigt: z.erledigt,
        kontrollzustand: z.erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
        kontrollhinweis: null,
        erledigtAm: null,
        erledigtVon: null,
        verantwortlich: personen.name(verantwortlichId),
        verantwortlichId,
        href: `/x/${z.id}`,
      };
    },
  };
}

function erzeuge(seed: number, mindestens = 1): Array<KontrollbuchQuelle<unknown, unknown>> {
  const rnd = mulberry32(seed);
  const anzahl = Math.max(mindestens, 1 + Math.floor(rnd() * 5));
  return Array.from({ length: anzahl }, (_, q) => {
    const zeilen: Zeile[] = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => {
      const r = rnd();
      const teil: Teil =
        r < 0.45 ? 'offen' : r < 0.6 ? 'vorbehalt' : r < 0.9 ? 'erledigt' : 'erledigtVorbehalt';
      return {
        // Gleiche IDs in verschiedenen Quellen sind erlaubt (Rang trennt).
        id: `id-${String(Math.floor(rnd() * 60)).padStart(2, '0')}-${i}`,
        clientId: `client-${Math.floor(rnd() * 5)}`,
        // Viele Gleichstände: wenige verschiedene Tage um den Stichtag.
        faelligAm: new Date(HEUTE.getTime() + (Math.floor(rnd() * 13) - 6) * TAG),
        teil,
        // Der sicher erledigte Teil bleibt erledigt; die Vorbehalte entscheidet toEintrag.
        erledigt:
          teil === 'offen'
            ? false
            : teil === 'erledigt'
              ? true
              : teil === 'vorbehalt'
                ? rnd() < 0.5
                : rnd() < 0.7,
      };
    });
    const gate = q === 1 ? (s: { reminders: boolean }) => s.reminders : () => true;
    return speicherQuelle(q * 2, zeilen, gate) as KontrollbuchQuelle<unknown, unknown>;
  });
}

function createTx() {
  return {
    clientResponsibility: {
      findMany: vi.fn(async ({ where }: { where: { clientId: { in: string[] } } }) =>
        where.clientId.in.map((clientId) => ({ clientId, staffId: `staff-${clientId}` })),
      ),
    },
    staffUser: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, fullName: `Name ${id}` })),
      ),
    },
  };
}

const session = {} as never;

describe('loadKontrollbuchSeite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ergibt seitenweise genau die vollständige Sicht, mit passenden Zählwerten', async () => {
    let geprueft = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      bestand.quellen = erzeuge(seed);
      for (const nurOffene of [true, false]) {
        const tx = createTx();
        const opts = { tage: 3, nurOffene, referenceDate: HEUTE };
        const voll = await loadKontrollbuch(tx as never, session, opts);
        const offen = voll.filter((e) => !e.erledigt);
        const erledigt = voll.filter((e) => e.erledigt);
        const abschluss = prepareDailyReview(
          await loadKontrollbuch(tx as never, session, { ...opts, tage: 0, nurOffene: true }),
          HEUTE,
        );
        for (const seitenGroesse of [1, 3, 10, 1000]) {
          const seiten: FristEintrag[] = [];
          for (let seite = 1; ; seite += 1) {
            const ergebnis = await loadKontrollbuchSeite(tx as never, session, {
              ...opts,
              seite,
              seitenGroesse,
              tagesabschluss: true,
            });
            expect(ergebnis.seite).toBe(seite);
            expect(ergebnis.offenGesamt).toBe(offen.length);
            expect(ergebnis.ueberfaellig).toBe(
              offen.filter((e) => e.faelligAm.getTime() < HEUTE.getTime()).length,
            );
            // Ohne erledigtSeite die erste Seite der erledigten Einträge.
            expect(ergebnis.erledigtGesamt).toBe(erledigt.length);
            expect(ergebnis.erledigtSeite).toBe(1);
            expect(ergebnis.erledigt).toEqual(erledigt.slice(0, seitenGroesse));
            expect(ergebnis.tagesabschluss).toEqual({
              offen: abschluss.openCount,
              ueberfaellig: abschluss.overdueCount,
            });
            expect(ergebnis.offen.length).toBeLessThanOrEqual(seitenGroesse);
            seiten.push(...ergebnis.offen);
            if (seite * seitenGroesse >= offen.length) break;
          }
          expect(seiten).toEqual(offen);

          // K-05: „Mit Erledigten“ blättert die erledigten Einträge ebenso.
          const erledigtSeiten: FristEintrag[] = [];
          for (let erledigtSeite = 1; ; erledigtSeite += 1) {
            const ergebnis = await loadKontrollbuchSeite(tx as never, session, {
              ...opts,
              seite: 1,
              erledigtSeite,
              seitenGroesse,
            });
            expect(ergebnis.erledigtSeite).toBe(erledigtSeite);
            expect(ergebnis.erledigtGesamt).toBe(erledigt.length);
            expect(ergebnis.offenGesamt).toBe(offen.length);
            expect(ergebnis.offen).toEqual(offen.slice(0, seitenGroesse));
            expect(ergebnis.erledigt.length).toBeLessThanOrEqual(seitenGroesse);
            erledigtSeiten.push(...ergebnis.erledigt);
            if (erledigtSeite * seitenGroesse >= erledigt.length) break;
          }
          expect(erledigtSeiten).toEqual(erledigt);
          geprueft += 1;
        }
      }
    }
    expect(geprueft).toBe(150 * 2 * 4);
  });

  it('begrenzt die angefragte Seite und lädt mit Seitengröße 0 nur Zählwerte', async () => {
    bestand.quellen = erzeuge(7, 3);
    const tx = createTx();
    const opts = { tage: 30, nurOffene: true, referenceDate: HEUTE };
    const nurOffene = await loadKontrollbuch(tx as never, session, opts);
    const offen = nurOffene.filter((e) => !e.erledigt);
    expect(offen.length).toBeGreaterThan(3);

    const letzte = await loadKontrollbuchSeite(tx as never, session, {
      ...opts,
      seite: 999,
      seitenGroesse: 3,
    });
    expect(letzte.seite).toBe(Math.ceil(offen.length / 3));

    const mitErledigten = { ...opts, nurOffene: false };
    const vollMitErledigten = await loadKontrollbuch(tx as never, session, mitErledigten);
    const erledigt = vollMitErledigten.filter((e) => e.erledigt);
    expect(erledigt.length).toBeGreaterThan(3);
    const letzteErledigte = await loadKontrollbuchSeite(tx as never, session, {
      ...mitErledigten,
      seite: 1,
      erledigtSeite: 999,
      seitenGroesse: 3,
    });
    expect(letzteErledigte.erledigtSeite).toBe(Math.ceil(erledigt.length / 3));
    expect(letzteErledigte.erledigt).toEqual(
      erledigt.slice((letzteErledigte.erledigtSeite - 1) * 3),
    );
    for (const erledigtSeite of [0, -1, Number.NaN, 1.5]) {
      const erste = await loadKontrollbuchSeite(tx as never, session, {
        ...mitErledigten,
        seite: 1,
        erledigtSeite,
        seitenGroesse: 3,
      });
      expect(erste.erledigtSeite).toBe(1);
      expect(erste.erledigt).toEqual(erledigt.slice(0, 3));
    }
    for (const seite of [0, -1, Number.NaN, 1.5]) {
      const erste = await loadKontrollbuchSeite(tx as never, session, {
        ...opts,
        seite,
        seitenGroesse: 3,
      });
      expect(erste.seite).toBe(1);
      expect(erste.offen).toEqual(offen.slice(0, 3));
    }

    vi.clearAllMocks();
    const zaehler = await loadKontrollbuchSeite(tx as never, session, {
      ...mitErledigten,
      seite: 1,
      seitenGroesse: 0,
    });
    expect(zaehler).toMatchObject({
      offen: [],
      erledigt: [],
      // Mit Rückschau zählen auch offen gebliebene Rückschau-Vorbehalte.
      offenGesamt: vollMitErledigten.length - erledigt.length,
      erledigtGesamt: erledigt.length,
    });
    // Auch ohne Rückschau zählt ein als erledigt abgeleiteter Vorbehalt des offenen Zweigs.
    await expect(
      loadKontrollbuchSeite(tx as never, session, { ...opts, seite: 1, seitenGroesse: 0 }),
    ).resolves.toMatchObject({ erledigtGesamt: nurOffene.filter((e) => e.erledigt).length });
    expect(tx.clientResponsibility.findMany).not.toHaveBeenCalled();
    expect(tx.staffUser.findMany).not.toHaveBeenCalled();
  });

  it('leitet den Tagesabschluss nur bei tenantweitem Umfang ab und zählt sonst eigens', async () => {
    bestand.quellen = erzeuge(11, 3);
    const tx = createTx();
    const abschluss = prepareDailyReview(
      await loadKontrollbuch(tx as never, session, {
        tage: 0,
        nurOffene: true,
        referenceDate: HEUTE,
      }),
      HEUTE,
    );
    const erwartet = {
      openCount: abschluss.openCount,
      overdueCount: abschluss.overdueCount,
      dueTodayCount: abschluss.dueTodayCount,
    };
    expect(erwartet.openCount).toBeGreaterThan(0);

    for (const opts of [
      { nurStaffId: 'staff-1' },
      { sources: { taxNotices: true, reminders: false } },
      {},
    ]) {
      const seite = await loadKontrollbuchSeite(tx as never, session, {
        tage: 90,
        nurOffene: false,
        referenceDate: HEUTE,
        seite: 1,
        seitenGroesse: 5,
        tagesabschluss: true,
        ...opts,
      });
      const ableitbar = Object.keys(opts).length === 0;
      expect(seite.tagesabschluss === null).toBe(!ableitbar);
      await expect(loadDailyReviewPreview(tx as never, session, seite)).resolves.toEqual(erwartet);
    }
  });
});
