// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001
// =============================================================================
// GwG-Status im Mandanten-Cockpit (K-01-Folgearbeit): Der Hinweis „läuft bald
// aus“ rechnet über gwgCheckDaysLeft aus @taxtronik/gwg — dieselbe Funktion,
// mit der der Worker (gwg-expiry-check) die 30-Tage-Warnstufe bildet.
//
// Vergleich mit der bisherigen Web-Rechnung (Restlaufzeit in Millisekunden
// unter 30 × 24 h) über Grenzdaten: heute fällig, morgen, abgelaufen, rund um
// 30 Tage und über beide Zeitumstellungen 2026. Beide Rechnungen messen
// verstrichene Zeit (24-h-Tage); die Ergebnisse sind identisch bis auf genau
// einen Zeitpunkt: verbleiben exakt 30 × 24 h, warnte das Web bisher nicht,
// während der Worker bereits Stufe 2 meldet. Jetzt warnen beide.
// =============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { gwgCheckDaysLeft, gwgExpiryStageForDaysLeft } from '@taxtronik/gwg/expiry';

// Die Kontakt-Actions der Cockpit-Karten laden next-auth; eine Session braucht der Test nicht.
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));

import { GwgStatusCockpitCard, gwgCheckExpiresSoon } from '../cockpit-cards';

const DAY = 24 * 60 * 60 * 1000;

/** Bisherige Web-Rechnung vor K-01-Folgearbeit (cockpit-cards.tsx). */
function legacyExpiresSoon(validUntil: Date | null, now: Date): boolean {
  return Boolean(validUntil && validUntil.getTime() - now.getTime() < 30 * DAY);
}

const NOWS: Record<string, Date> = {
  'Werktag 10:00 Berlin (Sommerzeit)': new Date('2026-06-09T08:00:00.000Z'),
  'kurz vor Berliner Mitternacht': new Date('2026-06-09T21:59:59.999Z'),
  'Vortag Sommerzeitbeginn (29.03.)': new Date('2026-03-28T11:00:00.000Z'),
  'Nacht der Zeitumstellung Sommerzeitbeginn': new Date('2026-03-29T00:30:00.000Z'),
  'Vortag Sommerzeitende (25.10.)': new Date('2026-10-24T10:00:00.000Z'),
  'Nacht der Zeitumstellung Sommerzeitende': new Date('2026-10-25T00:30:00.000Z'),
};

const at = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Grenzdaten relativ zu `now` (verstrichene Zeit). */
function relativeCases(now: Date): Array<[string, Date | null]> {
  return [
    ['ohne validUntil', null],
    ['abgelaufen seit gestern', at(now, -DAY)],
    ['abgelaufen seit 1 ms', at(now, -1)],
    ['genau jetzt fällig', now],
    ['heute in 1 ms fällig', at(now, 1)],
    ['morgen fällig', at(now, DAY)],
    ['in 29 Tagen', at(now, 29 * DAY)],
    ['30 Tage minus 1 h', at(now, 30 * DAY - 60 * 60 * 1000)],
    ['30 Tage minus 1 ms', at(now, 30 * DAY - 1)],
    ['30 Tage plus 1 ms', at(now, 30 * DAY + 1)],
    ['30 Tage plus 1 h', at(now, 30 * DAY + 60 * 60 * 1000)],
    ['in 31 Tagen', at(now, 31 * DAY)],
    ['in 90 Tagen', at(now, 90 * DAY)],
  ];
}

/** 30 Kalendertage zur selben Berliner Uhrzeit über eine Zeitumstellung (±1 h verstrichen). */
const CALENDAR_CASES: Array<[string, Date, Date]> = [
  [
    'über Sommerzeitbeginn: 30 Kalendertage = 30 Tage − 1 h',
    new Date('2026-03-15T11:00:00.000Z'), // 12:00 MEZ
    new Date('2026-04-14T10:00:00.000Z'), // 12:00 MESZ
  ],
  [
    'über Sommerzeitende: 30 Kalendertage = 30 Tage + 1 h',
    new Date('2026-10-10T10:00:00.000Z'), // 12:00 MESZ
    new Date('2026-11-09T11:00:00.000Z'), // 12:00 MEZ
  ],
  [
    'heute fällig: Berliner Tagesende',
    new Date('2026-10-25T09:00:00.000Z'), // 10:00 MEZ am Umstellungstag
    new Date('2026-10-25T22:59:59.999Z'), // 23:59:59,999 MEZ
  ],
  [
    'morgen fällig: Berliner Mitternacht nach Sommerzeitbeginn',
    new Date('2026-03-29T10:00:00.000Z'), // 12:00 MESZ
    new Date('2026-03-29T22:00:00.000Z'), // 00:00 MESZ am 30.03.
  ],
];

function render(validUntil: Date | null, now: Date): string {
  return renderToStaticMarkup(
    <GwgStatusCockpitCard
      clientId="client-1"
      now={now}
      latest={
        {
          id: 'check-1',
          status: 'VERIFIED',
          riskLevel: 'LOW',
          validUntil,
        } as never
      }
    />,
  );
}

describe('GwG-Status im Cockpit: Ablaufhinweis über gwgCheckDaysLeft (K-01)', () => {
  it.each(Object.entries(NOWS))(
    'liefert dieselben Ergebnisse wie die bisherige Web-Rechnung — %s',
    (_label, now) => {
      for (const [label, validUntil] of relativeCases(now)) {
        expect(gwgCheckExpiresSoon(validUntil, now), label).toBe(
          legacyExpiresSoon(validUntil, now),
        );
      }
    },
  );

  it.each(CALENDAR_CASES)('liefert dieselben Ergebnisse — %s', (_label, now, validUntil) => {
    expect(gwgCheckExpiresSoon(validUntil, now)).toBe(legacyExpiresSoon(validUntil, now));
  });

  it('weicht nur bei exakt 30 × 24 h Restlaufzeit ab und folgt dort der Worker-Stufe 2', () => {
    for (const now of Object.values(NOWS)) {
      const validUntil = at(now, 30 * DAY);
      expect(legacyExpiresSoon(validUntil, now)).toBe(false);
      expect(gwgCheckDaysLeft(validUntil, now)).toBe(30);
      expect(gwgExpiryStageForDaysLeft(gwgCheckDaysLeft(validUntil, now))).toBe('STAGE2');
      expect(gwgCheckExpiresSoon(validUntil, now)).toBe(true);
    }
  });

  it('warnt genau dann, wenn der Worker Stufe 2 oder 3 meldet', () => {
    for (const now of Object.values(NOWS)) {
      for (const [label, validUntil] of relativeCases(now)) {
        if (!validUntil) continue;
        const stage = gwgExpiryStageForDaysLeft(gwgCheckDaysLeft(validUntil, now));
        expect(gwgCheckExpiresSoon(validUntil, now), label).toBe(
          stage === 'STAGE2' || stage === 'STAGE3',
        );
      }
    }
  });

  it('zeigt den Hinweis in der Cockpit-Karte an den Grenzen', () => {
    const now = NOWS['Werktag 10:00 Berlin (Sommerzeit)']!;
    expect(render(at(now, 30 * DAY), now)).toContain(' · läuft bald aus');
    expect(render(at(now, -DAY), now)).toContain(' · läuft bald aus');
    expect(render(at(now, 30 * DAY + 1), now)).not.toContain('läuft bald aus');
    expect(render(at(now, 30 * DAY + 1), now)).toContain('Gültig bis');
    expect(render(null, now)).not.toContain('Gültig bis');
  });
});
