'use client';

// Klärung eines reservierten Quantenlos-Starts mit ungeklärtem Ausgang
// (TCMS-SAMPLE-PROOF-001): bekannten Job abholen, gesicherten Nachweis
// übernehmen oder eine bestätigte Nichtausführung begründet freigeben.

import type { LosStart, LosZiehungErgebnis } from '@/server/risk';
import { useLosRecovery } from './quantenlos-hooks';
import { freigabeMoeglich, jobAbholbar, nachweisUebernehmbar } from './quantenlos-state';

export function LosRecoveryPanel({
  openStart,
  onResolved,
}: {
  openStart: LosStart | null;
  onResolved: (result?: LosZiehungErgebnis) => void;
}) {
  const recovery = useLosRecovery(openStart, onResolved);

  if (!openStart) return null;
  return (
    <>
      <div className="alert-warning space-y-3">
        <p className="font-medium">
          Eine Ziehung wird bearbeitet oder ihr Ausgang ist noch ungeklärt.
        </p>
        <p className="text-sm">
          Bitte zuerst den laufenden Aufruf abwarten. Nach einem Abbruch mit dem Betreiber anhand
          von Zeitpunkt, Rahmen und Versuch prüfen, ob die Engine eine Ziehung angenommen hat. Eine
          neue Ziehung bleibt bis zur Klärung gesperrt.
        </p>
        <details className="text-xs">
          <summary>Gespeicherter Auftrag für die Betreiberklärung</summary>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(openStart, null, 2)}</pre>
        </details>
        {(recovery.savedJobId || recovery.savedProof) && (
          <button
            className="btn-secondary"
            disabled={recovery.busy}
            onClick={recovery.ladeGespeicherteAntwort}
          >
            Bereits gespeicherte Engine-Antwort zur Prüfung laden
          </button>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm">
            Ermittelte Remote-Job-ID
            <input
              className="input"
              value={recovery.jobId}
              onChange={(e) => recovery.setJobId(e.target.value)}
            />
          </label>
          <button
            className="btn-secondary"
            disabled={recovery.busy || !jobAbholbar(recovery)}
            onClick={() => recovery.recoverStart(false)}
          >
            Bestehenden Job abholen
          </button>
        </div>
        <details className="text-sm space-y-2">
          <summary>Bereits fertigen Engine-Nachweis wiederherstellen</summary>
          <p>
            Wenn die ursprüngliche Engine-Antwort beim Betreiber vorliegt, deren Objekt „nachweis“
            einfügen. Der Risk-Layer prüft es gegen den gespeicherten Rahmen; es erfolgt keine neue
            Ziehung. Eine positive Prüfung belegt allein nicht die Herkunft der Entropie.
          </p>
          <label className="block">
            Gesicherter Nachweis als JSON
            <textarea
              className="input"
              value={recovery.proof}
              onChange={(e) => recovery.setProof(e.target.value)}
            />
          </label>
          <button
            className="btn-secondary"
            disabled={recovery.busy || !nachweisUebernehmbar(recovery)}
            onClick={() => recovery.recoverStart(false)}
          >
            Nachweis prüfen und übernehmen
          </button>
        </details>
        <details className="text-sm space-y-2">
          <summary>Bestätigte Nichtausführung dokumentieren</summary>
          <p>
            Nur wenn der Betreiber die Nichtausführung bestätigt hat. Ein unbekanntes oder bereits
            abgeschlossenes Ergebnis rechtfertigt keine neue Ziehung.
          </p>
          <label className="block">
            Nachweis und Begründung
            <textarea
              className="input"
              maxLength={2000}
              value={recovery.releaseReason}
              onChange={(e) => recovery.setReleaseReason(e.target.value)}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={recovery.confirmedNotExecuted}
              onChange={(e) => recovery.setConfirmedNotExecuted(e.target.checked)}
            />
            Ich habe geprüft, dass keine Ziehung ausgeführt wurde.
          </label>
          <button
            className="btn-secondary"
            disabled={recovery.busy || !freigabeMoeglich(recovery)}
            onClick={() => recovery.recoverStart(true)}
          >
            Nichtausführung protokollieren und freigeben
          </button>
        </details>
      </div>
      {recovery.fehler && <p className="text-red-600 text-sm">{recovery.fehler}</p>}
    </>
  );
}
