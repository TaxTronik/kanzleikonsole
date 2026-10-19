// TCMS Stufe 3: Die Bausteine der Tax-CMS-Oberflächen nutzen nur Klassen der
// kanzleikonsole (globals.css) und decken Katalog und Vertrag vollständig ab.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KontaktRollenBodySchema } from '@taxtronik/tcms-contract';
import {
  ANZEIGE_BADGE,
  AUSWIRKUNG_BADGE,
  EREIGNISTYPEN,
  EREIGNIS_STATUS_BADGE,
  GRUNDELEMENTE,
  KLASSEN,
  KLASSE_BADGE,
  NORMSTUFE_BADGE,
} from '@taxtronik/tcms-domain';
import { aktiverTcmsBereich, tcmsBereichHref, TCMS_MANDANT_BEREICHE } from '../bereiche';
import { KATALOG_ICON_NAMEN } from '../icon';
import { TCMS_KONTAKT_ROLLEN } from '../rollen';
import {
  BADGE_KLASSEN,
  CHIP_KLASSEN,
  KLASSE_BADGE_KLASSE,
  KLASSE_CHIP,
  badgeKlasse,
  tonChip,
} from '../ton';

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

  it('führt genau die Kontaktrollen des Vertrags', () => {
    const rollen = KontaktRollenBodySchema.shape.rollen;
    expect(rollen.safeParse([...TCMS_KONTAKT_ROLLEN]).success).toBe(true);
    expect(rollen.safeParse(['GESCHAEFTSFUEHRER']).success).toBe(false);
    // Vollständig: jede Rolle des Vertrags ist in der Liste.
    const vertrag = (rollen.element as unknown as { options: readonly string[] }).options;
    expect([...vertrag].sort()).toEqual([...TCMS_KONTAKT_ROLLEN].sort());
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
