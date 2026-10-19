// TCMS Stufe 3: Die Bausteine der Tax-CMS-Oberflächen nutzen nur Klassen der
// kanzleikonsole (globals.css) und decken Katalog und Vertrag vollständig ab.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FREIGABE_NACHRICHT_ZWECKE,
  FreigabeZustellungSchema,
  KontaktRollenBodySchema,
  NACHRICHT_UNZUSTELLBAR_GRUENDE,
  ZUSTELL_STATUS,
} from '@taxtronik/tcms-contract';
import {
  ANZEIGE_BADGE,
  AUSWIRKUNG_BADGE,
  EREIGNISTYPEN,
  EREIGNIS_STATUS_BADGE,
  GRUNDELEMENTE,
  KLASSEN,
  KLASSE_BADGE,
  MANDANT_ROLLEN,
  NORMSTUFE_BADGE,
} from '@taxtronik/tcms-domain';
import { aktiverTcmsBereich, tcmsBereichHref, TCMS_MANDANT_BEREICHE } from '../bereiche';
import { KATALOG_ICON_NAMEN } from '../icon';
import {
  BADGE_KLASSEN,
  CHIP_KLASSEN,
  KLASSE_BADGE_KLASSE,
  KLASSE_CHIP,
  badgeKlasse,
  tonChip,
} from '../ton';
import {
  UNZUSTELLBAR_GRUND_LABEL,
  ZUSTELL_STATUS_ANZEIGE,
  ZUSTELL_ZWECK_LABEL,
  zustellungGescheitert,
  zustellungText,
} from '../zustellung';

const GLOBALS = readFileSync(join(__dirname, '..', '..', '..', 'app', 'globals.css'), 'utf8');
const definiert = (klasse: string) => new RegExp(`\\.${klasse}\\s*\\{`).test(GLOBALS);

describe('Farben nur aus globals.css', () => {
  it('jede verwendete Badge- und Chip-Klasse ist definiert (hell und dunkel gestaltet)', () => {
    for (const klasse of [...BADGE_KLASSEN, ...CHIP_KLASSEN]) {
      expect(definiert(klasse), klasse).toBe(true);
    }
    expect(definiert('badge-amber')).toBe(false);
  });

  it('jede Badge-Klasse der Domain landet auf einer definierten Klasse', () => {
    const domain = [
      ANZEIGE_BADGE,
      AUSWIRKUNG_BADGE,
      EREIGNIS_STATUS_BADGE,
      KLASSE_BADGE,
      NORMSTUFE_BADGE,
    ].flatMap((tabelle) => Object.values(tabelle) as string[]);
    for (const klasse of domain) expect(BADGE_KLASSEN).toContain(badgeKlasse(klasse));
    expect(badgeKlasse('badge-amber')).toBe('badge-yellow');
    expect(badgeKlasse('<script>')).toBe('badge-gray');
    for (const k of KLASSEN) {
      expect(BADGE_KLASSEN).toContain(KLASSE_BADGE_KLASSE[k]);
      expect(CHIP_KLASSEN).toContain(KLASSE_CHIP[k]);
    }
    expect(tonChip('violet')).toBe('chip-brand');
    expect(tonChip(undefined)).toBe('chip-brand');
  });
});

describe('Katalog und Vertrag', () => {
  it('kennt jedes Icon des Domain-Katalogs', () => {
    const namen = [...GRUNDELEMENTE.map((g) => g.icon), ...EREIGNISTYPEN.map((t) => t.icon)];
    for (const name of namen) expect(KATALOG_ICON_NAMEN, name).toContain(name);
  });

  it('Domain und Vertrag führen dieselben Kontaktrollen (vendorte Stände passen zusammen)', () => {
    const rollen = KontaktRollenBodySchema.shape.rollen;
    expect(rollen.safeParse([...MANDANT_ROLLEN]).success).toBe(true);
    expect(rollen.safeParse(['GESCHAEFTSFUEHRER']).success).toBe(false);
    // Vollständig: jede Rolle des Vertrags ist in der Liste.
    const vertrag = (rollen.element as unknown as { options: readonly string[] }).options;
    expect([...vertrag].sort()).toEqual([...MANDANT_ROLLEN].sort());
  });
});

describe('Zustellstatus (Vertrag bereiche/zustellung.ts)', () => {
  it('ein eigener Text je Status, Grund und Zweck des Vertrags, Badges aus globals.css', () => {
    expect(Object.keys(ZUSTELL_STATUS_ANZEIGE).sort()).toEqual([...ZUSTELL_STATUS].sort());
    expect(Object.keys(UNZUSTELLBAR_GRUND_LABEL).sort()).toEqual(
      [...NACHRICHT_UNZUSTELLBAR_GRUENDE].sort(),
    );
    expect(Object.keys(ZUSTELL_ZWECK_LABEL).sort()).toEqual([...FREIGABE_NACHRICHT_ZWECKE].sort());
    const labels = Object.values(ZUSTELL_STATUS_ANZEIGE).map((a) => a.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(Object.values(UNZUSTELLBAR_GRUND_LABEL)).size).toBe(
      NACHRICHT_UNZUSTELLBAR_GRUENDE.length,
    );
    for (const { badge } of Object.values(ZUSTELL_STATUS_ANZEIGE)) {
      expect(BADGE_KLASSEN).toContain(badge);
    }
  });

  it('gescheitert heißt unzustellbar oder verworfen; offen und zugestellt nicht', () => {
    const kopf = { zweck: 'FREIGABE_ANGEFORDERT', erstelltAm: '2026-10-01T08:00:00.000Z' } as const;
    const faelle = [
      [{ ...kopf, status: 'OFFEN' }, false],
      [{ ...kopf, status: 'ZUGESTELLT', am: '2026-10-01T08:01:00.000Z' }, false],
      [
        { ...kopf, status: 'UNZUSTELLBAR', am: '2026-10-02T08:00:00.000Z', grund: 'SONSTIGES' },
        true,
      ],
      [{ ...kopf, status: 'VERWORFEN', am: '2026-10-02T08:00:00.000Z' }, true],
    ] as const;
    for (const [z, gescheitert] of faelle) {
      // Jeder Fall ist eine gültige Antwort des Vertrags.
      expect(FreigabeZustellungSchema.safeParse(z).success).toBe(true);
      expect(zustellungGescheitert(z)).toBe(gescheitert);
    }
    expect(zustellungGescheitert(null)).toBe(false);
    expect(zustellungText(faelle[2][0])).toBe(
      'Anforderung: Nachricht unzustellbar (sonstiger Grund)',
    );
  });
});

describe('Unterseiten des Mandantenbereichs', () => {
  const basis = '/staff/clients/m1/tcms';

  it('listet alle geplanten Unterseiten genau einmal', () => {
    expect(TCMS_MANDANT_BEREICHE.map((b) => b.label)).toEqual([
      'Cockpit',
      'Kontakte & Rollen',
      'Einrichtung',
      'Profil',
      'Beschreibung',
      'Risiken',
      'Kontrollen',
      'Durchführungen',
      'Feststellungen',
      'Ereignisse',
      'Länder',
      'Kalender',
      'Prüfung',
      'Kommunikation',
    ]);
    expect(new Set(TCMS_MANDANT_BEREICHE.map((b) => b.pfad)).size).toBe(
      TCMS_MANDANT_BEREICHE.length,
    );
  });

  it('erkennt den aktiven Bereich am längsten Präfix, Cockpit nur exakt', () => {
    expect(aktiverTcmsBereich(basis, basis)?.label).toBe('Cockpit');
    expect(aktiverTcmsBereich(basis, `${basis}/feststellungen/f1`)?.label).toBe('Feststellungen');
    expect(aktiverTcmsBereich(basis, `${basis}/kontrollenx`)).toBeNull();
    expect(aktiverTcmsBereich(basis, '/staff/clients/m2/tcms/risiken')).toBeNull();
  });

  it('behält nur einen gültigen Stichtag in den Links', () => {
    expect(tcmsBereichHref(basis, '/risiken', '2026-09-30')).toBe(
      `${basis}/risiken?stand=2026-09-30`,
    );
    expect(tcmsBereichHref(basis, '/risiken', '2026-09-30&x=1')).toBe(`${basis}/risiken`);
    expect(tcmsBereichHref(basis, '', null)).toBe(basis);
  });
});
