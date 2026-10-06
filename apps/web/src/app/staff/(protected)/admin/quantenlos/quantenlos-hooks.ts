'use client';

// Bereichs-Hooks des Quantenlos-Panels: Zustand in den reinen Reducern aus
// quantenlos-state.ts, hier nur die Verdrahtung mit den Server-Actions. Ziehung
// und IBM-Zugang behalten ihre getrennten Transitionen (Busy-Anzeigen wie bisher).

import { useReducer, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { LosRahmenTyp, LosStart, LosZiehung, LosZiehungErgebnis } from '@/server/risk';
import type { IbmTokenStatus } from '@/server/settings/quantenlos';
import {
  ibmTokenEntfernenAction,
  ibmTokenSpeichernAction,
  losAbholenAction,
  losPruefenAction,
  losStartFreigebenAction,
  losStartWiederaufnehmenAction,
  losZiehenAction,
  rahmenVorschauAction,
} from './actions';
import {
  createIbmTokenState,
  createLosPanelState,
  createLosRecoveryState,
  freigabeFehler,
  freigabeInput,
  gespeicherteEngineAntwort,
  ibmTokenReducer,
  losPanelReducer,
  losRecoveryReducer,
  pruefInput,
  wiederaufnahmeFehler,
  wiederaufnahmeInput,
  ziehungInput,
  type LosBackend,
  type LosPanelInitial,
} from './quantenlos-state';

/** Rahmen-Vorschau, Ziehen, Abholen und Nachweisprüfung (eine gemeinsame Transition). */
export function useLosZiehung(initial: LosPanelInitial) {
  const router = useRouter();
  const [state, dispatch] = useReducer(losPanelReducer, initial, createLosPanelState);
  const [busy, start] = useTransition();

  function aktualisiereVorschau(von: string, bis: string, rahmenTyp: LosRahmenTyp) {
    dispatch({ type: 'rahmen', von, bis, rahmenTyp });
    start(async () => {
      const result = await rahmenVorschauAction({ von, bis, rahmenTyp });
      dispatch({ type: 'vorschau', result });
    });
  }

  function ziehen() {
    dispatch({ type: 'ziehung-gestartet' });
    start(async () => {
      const result = await losZiehenAction(ziehungInput(state));
      dispatch({ type: 'gezogen', result });
      if (!result.ok || !result.ergebnis) router.refresh();
    });
  }

  function abholen() {
    dispatch({ type: 'ziehung-gestartet' });
    start(async () => {
      const result = await losAbholenAction();
      dispatch({ type: 'abgeholt', result });
    });
  }

  function pruefen(ziehung: LosZiehung) {
    dispatch({ type: 'pruefung-gestartet', auditId: ziehung.auditId });
    start(async () => {
      const result = await losPruefenAction(pruefInput(ziehung));
      dispatch({ type: 'geprueft', auditId: ziehung.auditId, result });
    });
  }

  return {
    ...state,
    busy,
    setzeRahmenTyp: (rahmenTyp: LosRahmenTyp) =>
      aktualisiereVorschau(state.von, state.bis, rahmenTyp),
    setzeVon: (von: string) => aktualisiereVorschau(von, state.bis, state.rahmenTyp),
    setzeBis: (bis: string) => aktualisiereVorschau(state.von, bis, state.rahmenTyp),
    setzeK: (value: string) => dispatch({ type: 'k', value }),
    setzeBackend: (backend: LosBackend) => dispatch({ type: 'backend', backend }),
    ziehen,
    abholen,
    pruefen,
    startGeklaert: (result?: LosZiehungErgebnis) => dispatch({ type: 'start-geklaert', result }),
  };
}

/** IBM-Quantum-Zugang: maskierter Status, Eingabe, Speichern und Entfernen. */
export function useIbmToken(initial: IbmTokenStatus) {
  const [state, dispatch] = useReducer(ibmTokenReducer, initial, createIbmTokenState);
  const [tokenBusy, startToken] = useTransition();

  function tokenSpeichern() {
    dispatch({ type: 'gestartet' });
    startToken(async () => {
      const result = await ibmTokenSpeichernAction({ token: state.eingabe });
      dispatch({ type: 'gespeichert', result });
    });
  }

  function tokenEntfernen() {
    dispatch({ type: 'gestartet' });
    startToken(async () => {
      const result = await ibmTokenEntfernenAction();
      dispatch({ type: 'entfernt', result });
    });
  }

  return {
    ibmToken: state.status,
    tokenEingabe: state.eingabe,
    setTokenEingabe: (value: string) => dispatch({ type: 'eingabe', value }),
    tokenFehler: state.fehler,
    tokenBusy,
    tokenSpeichern,
    tokenEntfernen,
  };
}

/** Betreiberklärung eines reservierten Starts: Job abholen, Nachweis übernehmen oder freigeben. */
export function useLosRecovery(
  openStart: LosStart | null,
  onResolved: (result?: LosZiehungErgebnis) => void,
) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [state, dispatch] = useReducer(losRecoveryReducer, undefined, createLosRecoveryState);
  const gespeichert = gespeicherteEngineAntwort(openStart);

  function recoverStart(release: boolean) {
    if (!openStart) return;
    dispatch({ type: 'gestartet' });
    start(async () => {
      if (release) {
        const r = await losStartFreigebenAction(freigabeInput(openStart, state));
        if (!r.ok) {
          dispatch({ type: 'fehlgeschlagen', fehler: freigabeFehler(r) });
          return;
        }
        onResolved();
      } else {
        const r = await losStartWiederaufnehmenAction(wiederaufnahmeInput(openStart, state));
        if (!r.ok || !r.ergebnis) {
          dispatch({ type: 'fehlgeschlagen', fehler: wiederaufnahmeFehler(r) });
          return;
        }
        onResolved(r.ergebnis);
      }
      router.refresh();
    });
  }

  return {
    ...state,
    busy,
    savedJobId: gespeichert.jobId,
    savedProof: gespeichert.proof,
    ladeGespeicherteAntwort: () =>
      dispatch({
        type: 'gespeicherte-antwort',
        jobId: gespeichert.jobId,
        proof: gespeichert.proof,
      }),
    setJobId: (value: string) => dispatch({ type: 'job-id', value }),
    setProof: (value: string) => dispatch({ type: 'nachweis', value }),
    setReleaseReason: (value: string) => dispatch({ type: 'begruendung', value }),
    setConfirmedNotExecuted: (value: boolean) => dispatch({ type: 'bestaetigt', value }),
    recoverStart,
  };
}
