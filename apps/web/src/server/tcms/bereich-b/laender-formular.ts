// =============================================================================
// Formulare des Länder-Monitors lesen (TCMS Stufe 3, Demo
// server/actions/laender.ts). Einzel- und Sammelerfassung sowie „Land
// hinzufügen“ liefern dieselben Felder je Land; die Sammelerfassung mit
// Präfix `<Land>.`. Beträge in deutscher Schreibweise („12.345,67 €“).
//
// Geprüft wird nur die Form wie im Vertrag (`LandEingabeSchema`, Stand als
// Kalendertag). Ob ein Stand in der Zukunft liegt, „Lager seit“ zum Stand
// passt oder ein Land im Monitor ist, prüft der Dienst.
// =============================================================================

import { MAX_LAND_EUR } from '@taxtronik/tcms-contract';
import { z } from 'zod';
import type { ActionParseResult } from '@/server/actions/action-runner';
import { germanFieldError, validationFailure } from '@/server/actions/form-data';

const LAND = /^[A-Z]{2}$/;
const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Höchstzahl Länder je Erfassung wie im Vertrag (`LandStaendeBodySchema`). */
const MAX_LAENDER = 40;

/** Deutsche Schreibweise: Tausenderpunkte nur in Dreiergruppen, Komma als Dezimaltrennzeichen. */
const DEUTSCH = /^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
/** Punkt als Dezimaltrennzeichen (z. B. „1234.5“), nicht in Dreiergruppen. */
const PUNKT_DEZIMAL = /^\d+\.\d+$/;

/**
 * Betrag aus einem Formularfeld: leer → 0; deutsche Schreibweise
 * („12.345,67“, „10.000“ = zehntausend) oder Punkt als Dezimaltrennzeichen
 * („1234.5“). Alles andere (z. B. „1,234.56“) ist ungültig, statt still
 * falsch gelesen zu werden – an den Beträgen hängt die Lieferschwelle.
 */
export function betragAus(roh: unknown): number {
  const text = String(roh ?? '')
    .replace(/[\s\u00a0\u20ac]/g, '')
    .trim();
  if (text === '') return 0;
  if (DEUTSCH.test(text)) return Number(text.replace(/\./g, '').replace(',', '.'));
  if (PUNKT_DEZIMAL.test(text)) return Number(text);
  return Number.NaN;
}

const Betrag = z.preprocess(
  (roh) => betragAus(roh),
  z
    .number({ error: 'Bitte einen Betrag ab 0 € angeben.' })
    .finite()
    .min(0, 'Bitte einen Betrag ab 0 € angeben.')
    .max(MAX_LAND_EUR),
);

const LandFelder = z.object({
  fernverkaeufeLfdEur: Betrag,
  fernverkaeufeVorjahrEur: Betrag,
  lagerSeit: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
    z.string().regex(MONAT, 'Bitte einen Monat angeben.').nullable(),
  ),
  oss: z.preprocess((v) => v === 'on', z.boolean()),
  lokaleUstNr: z.preprocess((v) => v === 'on', z.boolean()),
  zmRelevant: z.preprocess((v) => v === 'on', z.boolean()),
  steuersaetzeGeprueftAm: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
    z.iso.date().nullable(),
  ),
});

export interface LandEingabeFormular {
  land: string;
  fernverkaeufeLfdEur: number;
  fernverkaeufeVorjahrEur: number;
  lagerSeit: string | null;
  oss: boolean;
  lokaleUstNr: boolean;
  zmRelevant: boolean;
  steuersaetzeGeprueftAm: string | null;
}

export interface LaenderFormular {
  datenstand: string;
  laender: LandEingabeFormular[];
}

type Issue = { path: PropertyKey[]; message: string };

function feld(formData: FormData, name: string): unknown {
  return formData.get(name) ?? undefined;
}

function liesLand(
  formData: FormData,
  land: string,
  praefix: string,
  issues: Issue[],
): LandEingabeFormular | null {
  const roh = Object.fromEntries(
    Object.keys(LandFelder.shape).map((name) => [name, feld(formData, `${praefix}${name}`)]),
  );
  const ergebnis = LandFelder.safeParse(roh, { error: germanFieldError });
  if (!ergebnis.success) {
    for (const issue of ergebnis.error.issues) {
      issues.push({ path: [`${praefix}${String(issue.path[0] ?? '')}`], message: issue.message });
    }
    return null;
  }
  return { land, ...ergebnis.data };
}

function datenstandAus(formData: FormData, issues: Issue[]): string | null {
  const roh = formData.get('datenstand');
  const ergebnis = z.iso.date().safeParse(typeof roh === 'string' ? roh.trim() : roh, {
    error: germanFieldError,
  });
  if (!ergebnis.success) {
    issues.push({ path: ['datenstand'], message: 'Bitte ein gültiges Datum angeben.' });
    return null;
  }
  return ergebnis.data;
}

/**
 * Einzel- oder Sammelerfassung: Ländercodes aus `land` (wiederholbar). Mit
 * `praefix: true` stehen die Felder je Land unter `<Land>.<feld>`.
 */
export function laenderAusFormular(
  formData: FormData,
  opts: { praefix: boolean },
): ActionParseResult<LaenderFormular> {
  const issues: Issue[] = [];
  const datenstand = datenstandAus(formData, issues);
  const codes = formData.getAll('land').map((x) => (typeof x === 'string' ? x.trim() : ''));
  if (
    codes.length === 0 ||
    codes.length > MAX_LAENDER ||
    codes.some((c) => !LAND.test(c)) ||
    new Set(codes).size !== codes.length
  ) {
    issues.push({ path: ['land'], message: 'Ungültige Auswahl.' });
    return validationFailure(issues);
  }
  if (!opts.praefix && codes.length !== 1) {
    issues.push({ path: ['land'], message: 'Ungültige Auswahl.' });
    return validationFailure(issues);
  }
  const laender = codes.map((land) =>
    liesLand(formData, land, opts.praefix ? `${land}.` : '', issues),
  );
  if (issues.length > 0 || datenstand === null) return validationFailure(issues);
  return { ok: true, data: { datenstand, laender: laender as LandEingabeFormular[] } };
}
