// Reine Zustandslogik des Quantenlos-Panels (TCMS-SAMPLE-PROOF-001): je
// Bereich ein typisierter Reducer — Ziehung (Rahmen, Ziehen, Abholen, Prüfen),
// IBM-Zugang und Klärung eines offenen Starts — plus Aktionspayloads und
// Meldungen. Fachliche Entscheidungen bleiben in den Server-Actions; hier wird
// nur der Anzeigezustand aus deren Ergebnissen fortgeschrieben.

import type { ActionResult } from '@/server/actions/staff-action';
import type {
  LosPruefErgebnis,
  LosRahmenTyp,
  LosStart,
  LosZiehung,
  LosZiehungErgebnis,
  PendingLos,
} from '@/server/risk';
import type { IbmTokenStatus } from '@/server/settings/quantenlos';

export type LosBackend = 'qpu' | 'simulator' | 'csprng';

export const VORSCHAU_FEHLGESCHLAGEN = 'Rahmen-Vorschau fehlgeschlagen.';
export const ZIEHUNG_FEHLGESCHLAGEN = 'Ziehung fehlgeschlagen.';
export const ABHOLEN_FEHLGESCHLAGEN = 'Abholen fehlgeschlagen.';
export const PRUEFUNG_FEHLGESCHLAGEN = 'Prüfung fehlgeschlagen.';
export const QUEUE_EINGEREIHT =
  'Der QPU-Job ist eingereiht — Ergebnis später über „Abholen" holen.';
export const QUEUE_WARTET_NOCH =
  'Der Job liegt noch in der IBM-Queue — bitte später erneut abholen.';

type ZiehungResult = ActionResult & { ergebnis?: LosZiehungErgebnis };

// --- Ziehung -------------------------------------------------------------------------

export interface LosPanelState {
  von: string;
  bis: string;
  rahmenTyp: LosRahmenTyp;
  /** Rahmengröße der Vorschau; null, solange sie ermittelt wird. */
  n: number | null;
  k: number;
  backend: LosBackend;
  /** Reservierter Start mit ungeklärtem Ausgang (sperrt neue Ziehungen). */
  openStart: LosStart | null;
  pending: PendingLos | null;
  ziehungen: LosZiehung[];
  /** Audit-ID der zuletzt in dieser Sitzung abgeschlossenen Ziehung. */
  neueste: string | null;
  fehler: string | null;
  queueHinweis: string | null;
  pruefErgebnisse: Record<string, LosPruefErgebnis>;
  /** Audit-ID der laufenden Nachweisprüfung. */
  pruefBusy: string | null;
}

export interface LosPanelInitial {
  initialZeitraum: { von: string; bis: string };
  initialN: number;
  initialPending: PendingLos | null;
  initialStart: LosStart | null;
  initialZiehungen: LosZiehung[];
}

export type LosPanelAction =
  /** Zeitraum oder Rahmenart geändert — die Vorschau wird neu ermittelt. */
  | { type: 'rahmen'; von: string; bis: string; rahmenTyp: LosRahmenTyp }
  | { type: 'vorschau'; result: ActionResult & { n?: number } }
  | { type: 'k'; value: string }
  | { type: 'backend'; backend: LosBackend }
  /** Ziehen oder Abholen beginnt: alte Meldungen verschwinden. */
  | { type: 'ziehung-gestartet' }
  | { type: 'gezogen'; result: ZiehungResult }
  | { type: 'abgeholt'; result: ZiehungResult }
  | { type: 'pruefung-gestartet'; auditId: string }
  | { type: 'geprueft'; auditId: string; result: ActionResult & { ergebnis?: LosPruefErgebnis } }
  /** Offener Start geklärt: freigegeben (ohne Ergebnis) oder wiederaufgenommen. */
  | { type: 'start-geklaert'; result?: LosZiehungErgebnis };

export function createLosPanelState({
  initialZeitraum,
  initialN,
  initialPending,
  initialStart,
  initialZiehungen,
}: LosPanelInitial): LosPanelState {
  return {
    von: initialZeitraum.von,
    bis: initialZeitraum.bis,
    rahmenTyp: 'subsumtion',
    n: initialN,
    k: Math.min(3, Math.max(1, initialN)),
    backend: 'qpu',
    openStart: initialStart,
    pending: initialPending,
    ziehungen: initialZiehungen,
    neueste: null,
    fehler: null,
    queueHinweis: null,
    pruefErgebnisse: {},
    pruefBusy: null,
  };
}

/** Eingabe der Stichprobengröße: mindestens 1, Leer-/Fehleingaben ergeben 1. */
export function normalisiereK(value: string): number {
  return Math.max(1, Number(value) || 1);
}

function hasOpenLos(pending: PendingLos | null, reservation: LosStart | null): boolean {
  return Boolean(pending || reservation);
}

/** Neue Ziehung gesperrt: offener Job/Start, Rahmen unbekannt oder leer, k > n. */
export function ziehungGesperrt(
  state: Pick<LosPanelState, 'pending' | 'openStart' | 'n' | 'k'>,
): boolean {
  return (
    hasOpenLos(state.pending, state.openStart) ||
    state.n === null ||
    state.n === 0 ||
    state.k > (state.n ?? 0)
  );
}

/** Ziehungs-Payload in unveränderter Feldreihenfolge. */
export function ziehungInput(
  state: Pick<LosPanelState, 'von' | 'bis' | 'k' | 'backend' | 'rahmenTyp'>,
) {
  return {
    von: state.von,
    bis: state.bis,
    k: state.k,
    backend: state.backend,
    rahmenTyp: state.rahmenTyp,
  };
}

/** Online-Attestierung nur sinnvoll, wenn ein IBM-Job existiert (QPU). */
export function pruefInput(ziehung: Pick<LosZiehung, 'auditId' | 'jobId'>) {
  return { auditId: ziehung.auditId, online: !!ziehung.jobId };
}

function mitAbgeschlossenerZiehung(state: LosPanelState, ziehung: LosZiehung): LosPanelState {
  return {
    ...state,
    ziehungen: [ziehung, ...state.ziehungen],
    neueste: ziehung.auditId,
    pending: null,
  };
}

function ziehungFehler(result: ActionResult, fallback: string): string {
  return !result.ok ? (result.error ?? fallback) : fallback;
}

function mitVorschau(state: LosPanelState, result: ActionResult & { n?: number }): LosPanelState {
  if (result.ok && result.n !== undefined) return { ...state, n: result.n };
  return { ...state, fehler: result.ok ? null : (result.error ?? VORSCHAU_FEHLGESCHLAGEN) };
}

function mitZiehungsergebnis(state: LosPanelState, result: ZiehungResult): LosPanelState {
  if (!result.ok || !result.ergebnis) {
    return { ...state, fehler: ziehungFehler(result, ZIEHUNG_FEHLGESCHLAGEN) };
  }
  const ergebnis = result.ergebnis;
  if (ergebnis.status === 'wartet') {
    return { ...state, pending: ergebnis.pending, queueHinweis: QUEUE_EINGEREIHT };
  }
  return mitAbgeschlossenerZiehung(state, ergebnis.ziehung);
}

function mitAbholergebnis(state: LosPanelState, result: ZiehungResult): LosPanelState {
  if (!result.ok || !result.ergebnis) {
    return { ...state, fehler: ziehungFehler(result, ABHOLEN_FEHLGESCHLAGEN) };
  }
  const ergebnis = result.ergebnis;
  if (ergebnis.status === 'wartet') return { ...state, queueHinweis: QUEUE_WARTET_NOCH };
  return mitAbgeschlossenerZiehung(state, ergebnis.ziehung);
}

function mitPruefergebnis(
  state: LosPanelState,
  auditId: string,
  result: ActionResult & { ergebnis?: LosPruefErgebnis },
): LosPanelState {
  if (result.ok && result.ergebnis) {
    return {
      ...state,
      pruefErgebnisse: { ...state.pruefErgebnisse, [auditId]: result.ergebnis },
      pruefBusy: null,
    };
  }
  if (!result.ok) {
    return { ...state, fehler: result.error ?? PRUEFUNG_FEHLGESCHLAGEN, pruefBusy: null };
  }
  return { ...state, pruefBusy: null };
}

/** Geklärter Start: Freigabe ohne Ergebnis, Wiederaufnahme wartend oder fertig. */
function mitGeklaertemStart(state: LosPanelState, result?: LosZiehungErgebnis): LosPanelState {
  if (result?.status === 'wartet') return { ...state, openStart: null, pending: result.pending };
  if (result?.status === 'fertig') {
    return { ...state, openStart: null, ziehungen: [result.ziehung, ...state.ziehungen] };
  }
  return { ...state, openStart: null };
}

export function losPanelReducer(state: LosPanelState, action: LosPanelAction): LosPanelState {
  switch (action.type) {
    case 'rahmen':
      return {
        ...state,
        von: action.von,
        bis: action.bis,
        rahmenTyp: action.rahmenTyp,
        n: null,
      };
    case 'vorschau':
      return mitVorschau(state, action.result);
    case 'k':
      return { ...state, k: normalisiereK(action.value) };
    case 'backend':
      return { ...state, backend: action.backend };
    case 'ziehung-gestartet':
      return { ...state, fehler: null, queueHinweis: null };
    case 'gezogen':
      return mitZiehungsergebnis(state, action.result);
    case 'abgeholt':
      return mitAbholergebnis(state, action.result);
    case 'pruefung-gestartet':
      return { ...state, pruefBusy: action.auditId };
    case 'geprueft':
      return mitPruefergebnis(state, action.auditId, action.result);
    case 'start-geklaert':
      return mitGeklaertemStart(state, action.result);
  }
}

// --- IBM-Zugang ----------------------------------------------------------------------

export const TOKEN_SPEICHERN_FEHLGESCHLAGEN = 'Speichern fehlgeschlagen.';
export const TOKEN_ENTFERNEN_FEHLGESCHLAGEN = 'Entfernen fehlgeschlagen.';

export interface IbmTokenState {
  /** Maskierter Status; der Token selbst kommt nie zurück in den Browser. */
  status: IbmTokenStatus;
  eingabe: string;
  fehler: string | null;
}

type TokenResult = ActionResult & { status?: IbmTokenStatus };

export type IbmTokenAction =
  | { type: 'eingabe'; value: string }
  | { type: 'gestartet' }
  | { type: 'gespeichert'; result: TokenResult }
  | { type: 'entfernt'; result: TokenResult };

export function createIbmTokenState(status: IbmTokenStatus): IbmTokenState {
  return { status, eingabe: '', fehler: null };
}

/** Speichern erst ab acht Zeichen (ohne Rand-Leerzeichen). */
export function tokenSpeicherbar(eingabe: string): boolean {
  return eingabe.trim().length >= 8;
}

export function ibmTokenReducer(state: IbmTokenState, action: IbmTokenAction): IbmTokenState {
  switch (action.type) {
    case 'eingabe':
      return { ...state, eingabe: action.value };
    case 'gestartet':
      return { ...state, fehler: null };
    case 'gespeichert': {
      const { result } = action;
      if (result.ok && result.status) return { ...state, status: result.status, eingabe: '' };
      if (!result.ok) return { ...state, fehler: result.error ?? TOKEN_SPEICHERN_FEHLGESCHLAGEN };
      return state;
    }
    case 'entfernt': {
      const { result } = action;
      if (result.ok && result.status) return { ...state, status: result.status };
      if (!result.ok) return { ...state, fehler: result.error ?? TOKEN_ENTFERNEN_FEHLGESCHLAGEN };
      return state;
    }
  }
}

// --- Klärung eines offenen Starts ----------------------------------------------------

export const FREIGABE_FEHLGESCHLAGEN = 'Freigabe fehlgeschlagen.';
export const WIEDERAUFNAHME_FEHLGESCHLAGEN = 'Wiederaufnahme fehlgeschlagen.';
/** Mindestlänge der Begründung einer bestätigten Nichtausführung. */
export const MIN_FREIGABE_BEGRUENDUNG = 30;

export interface LosRecoveryState {
  fehler: string | null;
  jobId: string;
  proof: string;
  releaseReason: string;
  confirmedNotExecuted: boolean;
}

export type LosRecoveryAction =
  | { type: 'job-id'; value: string }
  | { type: 'nachweis'; value: string }
  | { type: 'begruendung'; value: string }
  | { type: 'bestaetigt'; value: boolean }
  /** Bereits gespeicherte Engine-Antwort in die Prüffelder übernehmen. */
  | { type: 'gespeicherte-antwort'; jobId: string; proof: string }
  | { type: 'gestartet' }
  | { type: 'fehlgeschlagen'; fehler: string };

export function createLosRecoveryState(): LosRecoveryState {
  return { fehler: null, jobId: '', proof: '', releaseReason: '', confirmedNotExecuted: false };
}

export function losRecoveryReducer(
  state: LosRecoveryState,
  action: LosRecoveryAction,
): LosRecoveryState {
  switch (action.type) {
    case 'job-id':
      return { ...state, jobId: action.value };
    case 'nachweis':
      return { ...state, proof: action.value };
    case 'begruendung':
      return { ...state, releaseReason: action.value };
    case 'bestaetigt':
      return { ...state, confirmedNotExecuted: action.value };
    case 'gespeicherte-antwort':
      return { ...state, jobId: action.jobId, proof: action.proof };
    case 'gestartet':
      return { ...state, fehler: null };
    case 'fehlgeschlagen':
      return { ...state, fehler: action.fehler };
  }
}

/** Am Start gesicherte Engine-Antwort (Job-ID bzw. Nachweis) für die Betreiberklärung. */
export function gespeicherteEngineAntwort(openStart: LosStart | null): {
  jobId: string;
  proof: string;
} {
  return {
    jobId:
      typeof openStart?.engineResponse?.job_id === 'string' ? openStart.engineResponse.job_id : '',
    proof: openStart?.engineResponse?.nachweis
      ? JSON.stringify(openStart.engineResponse.nachweis, null, 2)
      : '',
  };
}

/** Abholen nur über eine Job-ID ohne parallel eingefügten Nachweis. */
export function jobAbholbar(state: Pick<LosRecoveryState, 'jobId' | 'proof'>): boolean {
  return Boolean(state.jobId.trim()) && !state.proof.trim();
}

/** Nachweis übernehmen nur ohne parallel eingetragene Job-ID. */
export function nachweisUebernehmbar(state: Pick<LosRecoveryState, 'jobId' | 'proof'>): boolean {
  return Boolean(state.proof.trim()) && !state.jobId.trim();
}

/** Freigabe nur nach bestätigter Nichtausführung mit ausreichender Begründung. */
export function freigabeMoeglich(
  state: Pick<LosRecoveryState, 'releaseReason' | 'confirmedNotExecuted'>,
): boolean {
  return (
    state.confirmedNotExecuted && state.releaseReason.trim().length >= MIN_FREIGABE_BEGRUENDUNG
  );
}

export function freigabeInput(openStart: Pick<LosStart, 'attemptId'>, state: LosRecoveryState) {
  return {
    attemptId: openStart.attemptId,
    reason: state.releaseReason,
    confirmedNotExecuted: state.confirmedNotExecuted,
  };
}

export function wiederaufnahmeInput(
  openStart: Pick<LosStart, 'attemptId'>,
  state: LosRecoveryState,
) {
  return { attemptId: openStart.attemptId, jobId: state.jobId, proofJson: state.proof };
}

export function freigabeFehler(result: ActionResult): string {
  return result.error ?? FREIGABE_FEHLGESCHLAGEN;
}

export function wiederaufnahmeFehler(result: ActionResult): string {
  return !result.ok
    ? (result.error ?? WIEDERAUFNAHME_FEHLGESCHLAGEN)
    : WIEDERAUFNAHME_FEHLGESCHLAGEN;
}
