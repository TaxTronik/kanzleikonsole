'use client';

// =============================================================================
// Quantenlos-Panel — Rahmen-Vorschau, Ziehen, Abholen (QPU-Queue), Historie
// mit „Nachweis prüfen" + zentrale IBM-Zugangs-Karte. Reine Anzeige-/
// Interaktionsschicht; alles Fachliche läuft über die Server-Actions.
// Zustand: quantenlos-state.ts (reine Reducer), Verdrahtung mit den Actions:
// quantenlos-hooks.ts, Historie/wartender Job: quantenlos-ziehungen.tsx,
// Klärung offener Starts: quantenlos-recovery.tsx.
// =============================================================================

import { Dices, KeyRound, Trash2 } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import { ThemeSync } from '@/components/theme-sync';
import type { LosZiehung, PendingLos, LosRahmenTyp, LosStart } from '@/server/risk';
import type { IbmTokenStatus } from '@/server/settings/quantenlos';
import { useIbmToken, useLosZiehung } from './quantenlos-hooks';
import { LosRecoveryPanel } from './quantenlos-recovery';
import { tokenSpeicherbar, ziehungGesperrt, type LosBackend } from './quantenlos-state';
import { LosZiehungenListe, PendingLosCard } from './quantenlos-ziehungen';

// Ehrliche Beschriftung: nur die QPU ist attestierbar; Simulator/CSPRNG sind
// Test/Fallback und werden im Ergebnis deutlich markiert.
const BACKENDS: { value: LosBackend; label: string; hinweis: string }[] = [
  {
    value: 'qpu',
    label: 'QPU — IBM-Quantenprozessor',
    hinweis:
      'Echte Quanten-Entropie, öffentlich attestierbar über die IBM-Job-ID. Kann in der Queue warten.',
  },
  {
    value: 'simulator',
    label: 'Simulator — Test',
    hinweis: 'Qiskit-Simulator: KEINE Quanten-Hardware, nicht attestierbar. Nur zum Ausprobieren.',
  },
  {
    value: 'csprng',
    label: 'CSPRNG — Fallback',
    hinweis:
      'Kryptografischer Pseudozufall des Engine-Hosts: nicht quantenbasiert, nicht extern attestierbar.',
  },
];

const RAHMEN_TYPEN: {
  value: LosRahmenTyp;
  label: string;
  hinweis: string;
  einheit: [string, string];
}[] = [
  {
    value: 'subsumtion',
    label: 'Subsumtionen — Risk-Review',
    hinweis:
      'Rahmen: die Subsumtionen des Zeitraums. Je Treffer entsteht eine Review-Wiedervorlage (+14 Tage).',
    einheit: ['Subsumtion', 'Subsumtionen'],
  },
  {
    value: 'audit',
    label: 'Audit-Ereignisse — Betriebs-Nachschau',
    hinweis:
      'Rahmen: ALLE Chain-Ereignisse des Zeitraums (nur laufende Nummern an die Engine). Blinde Nachschau über das protokollierte Handeln — Treffer direkt hier reviewen, keine automatischen Aufgaben.',
    einheit: ['Audit-Ereignis', 'Audit-Ereignisse'],
  },
];

interface Props {
  initialZeitraum: { von: string; bis: string };
  initialN: number;
  initialPending: PendingLos | null;
  initialStart: LosStart | null;
  initialZiehungen: LosZiehung[];
  initialIbmToken: IbmTokenStatus;
}

export function QuantenlosPanel({ initialIbmToken, ...initial }: Props) {
  const los = useLosZiehung(initial);
  const token = useIbmToken(initialIbmToken);

  return (
    <div className="space-y-6">
      <ThemeSync />

      {/* IBM-Quantum-Zugang — zentrale Config statt Credentials auf der Engine-Maschine */}
      <IbmTokenCard {...token} />

      {/* Ziehungs-Formular */}
      <LosZiehungForm {...los} ibmTokenHinterlegt={token.ibmToken.hinterlegt} />

      {/* Wartender QPU-Job */}
      <LosRecoveryPanel openStart={los.openStart} onResolved={los.startGeklaert} />
      {los.pending && (
        <PendingLosCard
          pending={los.pending}
          queueHinweis={los.queueHinweis}
          busy={los.busy}
          onAbholen={los.abholen}
        />
      )}

      {/* Historie inkl. frischem Ergebnis */}
      <LosZiehungenListe
        ziehungen={los.ziehungen}
        neueste={los.neueste}
        pruefErgebnisse={los.pruefErgebnisse}
        pruefBusy={los.pruefBusy}
        onPruefen={los.pruefen}
      />
    </div>
  );
}

// IBM-Zugang (zentrale Config) — der Token selbst bleibt im Eingabefeld,
// zurück kommt nur der maskierte Status.
function IbmTokenCard({
  ibmToken,
  tokenEingabe,
  setTokenEingabe,
  tokenFehler,
  tokenBusy,
  tokenSpeichern,
  tokenEntfernen,
}: ReturnType<typeof useIbmToken>) {
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-brand-700" />
        IBM-Quantum-Zugang
      </h2>
      <p className="text-xs text-muted mb-3">
        Der API-Token (quantum.ibm.com) wird hier AES-256-GCM-verschlüsselt gespeichert und der
        Engine nur pro Ziehung mitgereicht — sie persistiert und loggt ihn nie. Ohne Token nutzt die
        Engine ihren Maschinen-Zugang, falls auf dem Engine-Host hinterlegt.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        {ibmToken.hinterlegt ? (
          <>
            <span className="badge badge-green">Token hinterlegt</span>
            <code className="font-mono text-xs text-secondary">***{ibmToken.suffix ?? ''}</code>
            {ibmToken.gesetztAm && (
              <span className="text-xs text-muted">
                gesetzt {fmtDateTimeShort(new Date(ibmToken.gesetztAm))}
              </span>
            )}
            <button onClick={tokenEntfernen} disabled={tokenBusy} className="btn-secondary text-xs">
              <Trash2 className="h-3.5 w-3.5" />
              Entfernen
            </button>
          </>
        ) : (
          <span className="badge badge-gray">Kein Token hinterlegt</span>
        )}
      </div>
      <form
        autoComplete="off"
        className="flex items-end gap-2 mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          tokenSpeichern();
        }}
      >
        <div className="flex-1 max-w-md">
          <label className="label" htmlFor="ibm-token">
            {ibmToken.hinterlegt ? 'Token ersetzen' : 'Token hinterlegen'}
          </label>
          <input
            id="ibm-token"
            name="ibm-quantum-api-token"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className="input text-xs font-mono"
            placeholder="IBM-Quantum-API-Token"
            value={tokenEingabe}
            onChange={(e) => setTokenEingabe(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={tokenBusy || !tokenSpeicherbar(tokenEingabe)}
          className="btn-primary text-xs"
        >
          {tokenBusy ? 'Speichert …' : 'Speichern'}
        </button>
      </form>
      {tokenFehler && <p className="text-xs text-red-600 dark:text-red-300 mt-2">{tokenFehler}</p>}
    </div>
  );
}

type LosZiehungFormProps = Pick<
  ReturnType<typeof useLosZiehung>,
  | 'von'
  | 'bis'
  | 'rahmenTyp'
  | 'n'
  | 'k'
  | 'backend'
  | 'pending'
  | 'openStart'
  | 'fehler'
  | 'busy'
  | 'setzeRahmenTyp'
  | 'setzeVon'
  | 'setzeBis'
  | 'setzeK'
  | 'setzeBackend'
  | 'ziehen'
> & { ibmTokenHinterlegt: boolean };

function LosZiehungForm({
  von,
  bis,
  rahmenTyp,
  n,
  k,
  backend,
  pending,
  openStart,
  fehler,
  busy,
  setzeRahmenTyp,
  setzeVon,
  setzeBis,
  setzeK,
  setzeBackend,
  ziehen,
  ibmTokenHinterlegt,
}: LosZiehungFormProps) {
  const backendInfo = BACKENDS.find((b) => b.value === backend)!;
  const typInfo = RAHMEN_TYPEN.find((t) => t.value === rahmenTyp)!;
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
        <Dices className="h-4 w-4 text-brand-700" />
        Neue Stichprobe ziehen
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div>
          <label className="label" htmlFor="rahmenTyp">
            Prüfrahmen
          </label>
          <select
            id="rahmenTyp"
            className="input text-xs"
            value={rahmenTyp}
            onChange={(e) => setzeRahmenTyp(e.target.value as LosRahmenTyp)}
          >
            {RAHMEN_TYPEN.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="von">
            Zeitraum von
          </label>
          <input
            id="von"
            type="date"
            className="input text-xs"
            value={von}
            onChange={(e) => setzeVon(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="bis">
            Zeitraum bis
          </label>
          <input
            id="bis"
            type="date"
            className="input text-xs"
            value={bis}
            onChange={(e) => setzeBis(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="k">
            Stichprobe (k)
          </label>
          <input
            id="k"
            type="number"
            min={1}
            max={n ?? 500}
            className="input text-xs"
            value={k}
            onChange={(e) => setzeK(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="backend">
            Zufallsquelle
          </label>
          <select
            id="backend"
            className="input text-xs"
            value={backend}
            onChange={(e) => setzeBackend(e.target.value as LosBackend)}
          >
            {BACKENDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-xs text-muted mt-2">{typInfo.hinweis}</p>
      <p className="text-xs text-muted mt-1">
        {backendInfo.hinweis}
        {backend === 'qpu' && !ibmTokenHinterlegt && (
          <span className="text-yellow-700 dark:text-yellow-300">
            {' '}
            Kein Token hinterlegt — die Ziehung gelingt nur, wenn der Engine-Host eigene
            IBM-Credentials hat (sonst klare Ablehnung, keine stille Degradation).
          </span>
        )}
      </p>

      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-secondary">
          Rahmen:{' '}
          {n === null ? (
            <span className="text-disabled">wird ermittelt …</span>
          ) : (
            <>
              <span className="font-semibold">{n}</span>{' '}
              {n === 1 ? typInfo.einheit[0] : typInfo.einheit[1]} im Zeitraum — es werden
              ausschließlich IDs an die Engine übertragen.
            </>
          )}
        </p>
        <button
          onClick={ziehen}
          disabled={busy || ziehungGesperrt({ pending, openStart, n, k })}
          className="btn-primary text-xs"
          title={pending ? 'Es wartet noch ein QPU-Job — bitte zuerst abholen.' : undefined}
        >
          <Dices className="h-4 w-4" />
          {busy ? 'Zieht …' : 'Stichprobe ziehen'}
        </button>
      </div>
      {fehler && <p className="text-xs text-red-600 dark:text-red-300 mt-2">{fehler}</p>}
    </div>
  );
}
