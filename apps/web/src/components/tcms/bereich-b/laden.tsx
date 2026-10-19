// =============================================================================
// Gemeinsame Auswertung der Lesezugriffe der Seiten des Bereichs B (TCMS
// Stufe 3): Jede Seite liest den Kontext (Rechte, Programm, Stichtag) und
// meist einen weiteren Endpunkt. Die Reihenfolge der Zustände ist für alle
// gleich: Fehler des Dienstes → Zustand; Mandant nicht im Tax-CMS → Hinweis;
// zweiter Endpunkt 404 trotz Kontext → notFound(); kein Programm → Hinweis
// „noch nicht eingerichtet“ (Einrichten nur mit `rechte.bearbeiten`).
// =============================================================================

import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { StandSchema, type KontextAntwort } from '@taxtronik/tcms-contract';
import type { TcmsLeseErgebnis } from '@/server/tcms/seite';
import type { TcmsSeitenZustand } from '@/server/tcms/zustand';
import type { TcmsKopfDaten } from '../kopf';
import { TcmsZustand } from '../zustand';
import { NichtImTcms, OhneProgramm } from './leer';
import { param, type SuchParameter } from './seite';

export type KontextMitProgramm = KontextAntwort & {
  programm: NonNullable<KontextAntwort['programm']>;
};

export type Geladen<T> =
  | { ok: true; ctx: KontextMitProgramm; daten: T }
  | { ok: false; anzeige: ReactNode };

/** Query der Lesezugriffe: nur ein gültiger Stichtag wird weitergegeben. */
export function standQuery(sp: SuchParameter): { stand?: string } {
  const stand = StandSchema.safeParse(param(sp, 'stand'));
  return stand.success ? { stand: stand.data } : {};
}

/** Nur der Kontext (Kalender, Prüfung) → Kontext mit Programm oder anzuzeigender Zustand. */
export function auswertenKontext(
  basis: string,
  kontext: TcmsLeseErgebnis<KontextAntwort | null>,
  icon?: LucideIcon,
): Geladen<null> {
  if (!kontext.ok) return { ok: false, anzeige: <TcmsZustand zustand={kontext.zustand} /> };
  if (kontext.daten === null) return { ok: false, anzeige: <NichtImTcms basis={basis} /> };
  const ctx = kontext.daten;
  if (!ctx.programm) {
    return {
      ok: false,
      anzeige: (
        <OhneProgramm
          basis={basis}
          bearbeiten={ctx.rechte.bearbeiten}
          {...(icon ? { icon } : {})}
        />
      ),
    };
  }
  return { ok: true, ctx: ctx as KontextMitProgramm, daten: null };
}

/** Kontext und ein zweiter Lesezugriff → Daten oder anzuzeigender Zustand. */
export function auswerten<T>(
  basis: string,
  kontext: TcmsLeseErgebnis<KontextAntwort | null>,
  zweit: TcmsLeseErgebnis<T | null>,
  icon?: LucideIcon,
): Geladen<T> {
  if (!kontext.ok) return { ok: false, anzeige: <TcmsZustand zustand={kontext.zustand} /> };
  if (!zweit.ok) return { ok: false, anzeige: <TcmsZustand zustand={zweit.zustand} /> };
  const geprueft = auswertenKontext(basis, kontext, icon);
  if (!geprueft.ok) return geprueft;
  // Kontext vorhanden, aber der zweite Endpunkt kennt den Mandanten nicht:
  // keine Existenz raten, wie jede andere 404.
  if (zweit.daten === null) notFound();
  return { ok: true, ctx: geprueft.ctx, daten: zweit.daten };
}

/** Kopfdaten (Teilbereich, Phase, Stichtag) aus dem Kontext. */
export function kopfDaten(ctx: KontextAntwort): TcmsKopfDaten {
  return {
    teilbereich: ctx.teilbereich,
    aktivePhase: ctx.aktivePhase,
    historisch: ctx.historisch,
    stand: ctx.stand,
    heute: ctx.heute,
    ausgeblendet: ctx.ausgeblendet,
  };
}

/** Ergebnis eines optionalen Detail-Lesezugriffs für einen Detailbereich. */
export type DetailErgebnis<T> =
  | { ok: true; daten: T }
  | { ok: false; zustand: TcmsSeitenZustand }
  | null;

export function detailAus<T>(ergebnis: TcmsLeseErgebnis<T | null> | null): DetailErgebnis<T> {
  if (ergebnis === null) return null;
  if (!ergebnis.ok) return { ok: false, zustand: ergebnis.zustand };
  return ergebnis.daten === null ? null : { ok: true, daten: ergebnis.daten };
}
