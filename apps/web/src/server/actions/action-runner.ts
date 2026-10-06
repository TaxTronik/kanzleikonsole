// =============================================================================
// Mehrphasige Server-Actions (Review-Befund K-02): EIN Baustein für Actions, die
// mehr tun als eine Tenant-Transaktion — mehrere Transaktionen, Services,
// Storage-Arbeit außerhalb der Transaktion, Nacharbeiten nach dem Commit.
//
//   guard → parse (Feldfehler) → run → zentrales Fehler-Mapping → revalidate
//
// Vorher schrieb jede dieser Actions die Zeremonie selbst (staffActionGuard,
// withTenantContext, try/catch, toActionError, revalidatePath). Gebunden an das
// Staff- bzw. Portal-Gate steht der Baustein als `staffAction` in
// staff-action.ts und als `portalAction` in portal-action.ts bereit; Actions mit
// genau einer Transaktion bleiben bei withStaff/withPortalContext.
//
// Zielvertrag der Fehlerkanäle (für alle Staff- und Portal-Actions):
//   • Ergebnis `ActionResult` — `{ ok: false, error, errorCode?, fieldErrors? }`
//     ist der einzige Rückkanal für Berechtigungs-, Validierungs-, Fach- und
//     technische Fehler. Fachfehler werden als ActionError geworfen (die Meldung
//     erreicht das UI), Validierungsfehler kommen aus parseFormData/
//     parseActionInput mit Feldzuordnung, alles Übrige ordnet toActionError ein,
//     ohne rohe Meldungen preiszugeben.
//   • `redirect()` nur zur Navigation NACH Erfolg, außerhalb des Fehler-Mappings:
//     die Action prüft `result.ok` und leitet erst dann weiter. Innerhalb des
//     Mappings endete NEXT_REDIRECT als „Unerwarteter Fehler“.
//   • Kein `throw` aus der Action heraus, kein stilles `return`, keine Rohmeldung
//     (`error: e.message`). Verbliebene Ausnahmen führt die Baseline von
//     server-action-style.test.ts mit Begründung.
//
// Bewusst ohne Auth-/Session-Imports: Unit-Tests binden den echten Ablauf an ein
// gemocktes Gate (`createActionRunner(mockGuard)`).
// =============================================================================

import { revalidatePath } from 'next/cache';
import { isUniqueViolation } from './database-error';
import { toActionError, type ActionErrorResult } from './to-action-error';
import type { ActionResult } from './types';

/** Fehlerergebnis, das unverändert beim Client ankommt (inkl. errorCode, fieldErrors). */
export type ActionFailure = ActionResult & { ok: false; error: string };

/** Ergebnis der Eingabeprüfung: parseFormData/parseActionInput oder eine eigene Meldung. */
export type ActionParseResult<TData> = { ok: true; data: TData } | ActionFailure;

/** Ergebnis eines Gates (staffActionGuard/portalActionGuard). */
export type ActionGuardResult<TCtx> = ({ ok: true } & TCtx) | { ok: false; error: string };

/**
 * Nutzlast aus dem, was `run` zurückgibt: Fehlerergebnisse (`ok: false`) und
 * die Ergebnisfelder selbst gehören nicht dazu; kein Rückgabewert ist eine
 * leere Nutzlast. Ohne diese Filterung zöge die Typinferenz frühe
 * `return { ok: false, … }`-Zweige in die Nutzlast.
 */
type SuccessPayload<T> = T extends { ok: false }
  ? never
  : T extends object
    ? Omit<T, keyof ActionResult>
    : Record<never, never>;

/** Was `run` zurückgeben darf: nichts, eine Nutzlast oder ein Fehlerergebnis. */
export type ActionRunResult = ActionFailure | object | void | undefined;

/** Erfolgsergebnis mit Nutzlast; die Fehlerfelder sind ausdrücklich leer. */
export type ActionSuccess<TPayload> = {
  ok: true;
  error?: undefined;
  errorCode?: undefined;
  fieldErrors?: undefined;
} & TPayload;

/**
 * Ergebnis eines Bausteins als unterscheidbare Union: nach
 * `if (!result.ok) return result;` ist die Nutzlast von `run` vollständig
 * typisiert (etwa für eine Weiterleitung nach Erfolg).
 */
export type ActionOutcome<TRun> = ActionSuccess<SuccessPayload<TRun>> | ActionFailure;

export interface ActionErrorMapping {
  /** Freundliche Meldung für Eindeutigkeits-Konflikte (P2002 bzw. SQLSTATE 23505). */
  uniqueError?: string;
}

/**
 * Zentrales Fehler-Mapping aller Action-Bausteine (withStaff, withPortalContext,
 * staffAction, portalAction): optional die Eindeutigkeits-Meldung, sonst
 * toActionError.
 */
export function mapActionError(
  error: unknown,
  mapping: ActionErrorMapping = {},
): ActionErrorResult {
  if (mapping.uniqueError && isUniqueViolation(error)) {
    return { ok: false, error: mapping.uniqueError };
  }
  return toActionError(error);
}

export interface ActionSpec<TCtx, TGuardOptions, TData, TRun> extends ActionErrorMapping {
  /** Optionen des Gates (Admin, Einzelrecht, Modul …); läuft immer zuerst. */
  guard?: TGuardOptions;
  /**
   * Beobachtet eine Ablehnung durch das Gate (z. B. strukturiertes Log), bevor
   * sie unverändert zurückgeht.
   */
  onDenied?: (error: string) => void;
  /**
   * Eingabeprüfung NACH dem Gate. Ein Fehlerergebnis (etwa mit `fieldErrors`)
   * geht unverändert zurück; `run` erhält die geprüften Daten.
   */
  parse?: () => ActionParseResult<TData>;
  /**
   * Die eigentliche Arbeit. Darf mehrere Transaktionen öffnen, Services rufen
   * und Storage-Arbeit außerhalb einer Transaktion erledigen. Fachfehler als
   * ActionError werfen; ein zurückgegebenes `{ ok: false, … }` geht unverändert
   * (ohne Revalidate) an den Client. Eine Nutzlast wird flach ins
   * Erfolgsergebnis gemischt (`{ ok: true, ...payload }`).
   */
  run: (ctx: TCtx, data: TData) => Promise<TRun>;
  /** Pfade, die nach Erfolg revalidiert werden (dynamische Pfade ruft `run` selbst). */
  revalidate?: string | readonly string[];
  /**
   * Action-spezifische Einordnung bestimmter Fehler (z. B. ein typisierter
   * Konflikt mit Zusatzfeldern). `undefined` → zentrales Mapping.
   */
  onError?: (error: unknown) => ActionFailure | undefined | Promise<ActionFailure | undefined>;
}

function isFailure(value: unknown): value is ActionFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Bindet den Ablauf an ein Gate. Auch das Gate läuft im Fehler-Mapping: fällt
 * dort Infrastruktur aus (Session-Widerruf, Modulstatus), antwortet die Action
 * mit einem Ergebnis statt einer Fehlerseite. Eine Ablehnung des Gates geht
 * unverändert zurück.
 */
export function createActionRunner<TCtx extends object, TGuardOptions>(
  guard: (options?: TGuardOptions) => Promise<ActionGuardResult<TCtx>>,
) {
  return async function runAction<TRun extends ActionRunResult = void, TData = undefined>(
    spec: ActionSpec<TCtx, TGuardOptions, TData, TRun>,
  ): Promise<ActionOutcome<TRun>> {
    // Fehlerpfade tragen keine Nutzlast → der Cast nach ActionOutcome ist korrekt.
    type R = ActionOutcome<TRun>;
    try {
      const g = await guard(spec.guard);
      if (!g.ok) {
        spec.onDenied?.(g.error);
        return g as R;
      }
      let data = undefined as TData;
      if (spec.parse) {
        const parsed = spec.parse();
        if (!parsed.ok) return parsed as R;
        data = parsed.data;
      }
      const out: ActionRunResult = await spec.run(g, data);
      if (isFailure(out)) return out as R;
      if (spec.revalidate) {
        for (const path of ([] as string[]).concat(spec.revalidate)) revalidatePath(path);
      }
      return { ok: true, ...(out ?? {}) } as R;
    } catch (error) {
      const mapped = spec.onError ? await spec.onError(error) : undefined;
      return (mapped ?? mapActionError(error, spec)) as R;
    }
  };
}
