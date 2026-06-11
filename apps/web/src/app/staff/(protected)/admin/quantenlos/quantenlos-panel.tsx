'use client';

// =============================================================================
// Quantenlos-Panel — Rahmen-Vorschau, Ziehen, Abholen (QPU-Queue), Historie
// mit „Nachweis prüfen". Reine Anzeige-/Interaktionsschicht; alles Fachliche
// läuft über die Server-Actions.
// =============================================================================

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Dices, ShieldCheck, ShieldAlert, RefreshCw, Hourglass } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { LosZiehung, PendingLos, LosPruefErgebnis } from '@/server/risk';
import {
  rahmenVorschauAction,
  losZiehenAction,
  losAbholenAction,
  losPruefenAction,
} from './actions';

type Backend = 'qpu' | 'simulator' | 'csprng';

// Ehrliche Beschriftung: nur die QPU ist attestierbar; Simulator/CSPRNG sind
// Test/Fallback und werden im Ergebnis deutlich markiert.
const BACKENDS: { value: Backend; label: string; hinweis: string }[] = [
  {
    value: 'qpu',
    label: 'QPU — IBM-Quantenprozessor',
    hinweis: 'Echte Quanten-Entropie, öffentlich attestierbar über die IBM-Job-ID. Kann in der Queue warten.',
  },
  {
    value: 'simulator',
    label: 'Simulator — Test',
    hinweis: 'Qiskit-Simulator: KEINE Quanten-Hardware, nicht attestierbar. Nur zum Ausprobieren.',
  },
  {
    value: 'csprng',
    label: 'CSPRNG — Fallback',
    hinweis: 'Kryptografischer Pseudozufall des Engine-Hosts: nicht quantenbasiert, nicht extern attestierbar.',
  },
];

function QuelleBadge({ quelleKlasse }: { quelleKlasse: string }) {
  if (quelleKlasse === 'qpu') return <span className="badge badge-purple">QPU (attestierbar)</span>;
  if (quelleKlasse === 'simulator') return <span className="badge badge-yellow">Simulator — Test</span>;
  return <span className="badge badge-gray">CSPRNG — Fallback</span>;
}

function Mono({ value, max = 24 }: { value: string; max?: number }) {
  const kurz = value.length > max ? `${value.slice(0, max)}…` : value;
  return (
    <code className="font-mono text-xs text-secondary break-all" title={value}>
      {kurz}
    </code>
  );
}

interface Props {
  initialZeitraum: { von: string; bis: string };
  initialN: number;
  initialPending: PendingLos | null;
  initialZiehungen: LosZiehung[];
}

export function QuantenlosPanel({ initialZeitraum, initialN, initialPending, initialZiehungen }: Props) {
  const [von, setVon] = useState(initialZeitraum.von);
  const [bis, setBis] = useState(initialZeitraum.bis);
  const [n, setN] = useState<number | null>(initialN);
  const [k, setK] = useState(Math.min(3, Math.max(1, initialN)));
  const [backend, setBackend] = useState<Backend>('qpu');
  const [pending, setPending] = useState<PendingLos | null>(initialPending);
  const [ziehungen, setZiehungen] = useState<LosZiehung[]>(initialZiehungen);
  const [neueste, setNeueste] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [queueHinweis, setQueueHinweis] = useState<string | null>(null);
  const [pruefErgebnisse, setPruefErgebnisse] = useState<Record<string, LosPruefErgebnis>>({});
  const [busy, start] = useTransition();
  const [pruefBusy, setPruefBusy] = useState<string | null>(null);

  const backendInfo = BACKENDS.find((b) => b.value === backend)!;

  function aktualisiereVorschau(nextVon: string, nextBis: string) {
    setN(null);
    start(async () => {
      const r = await rahmenVorschauAction({ von: nextVon, bis: nextBis });
      if (r.ok && r.n !== undefined) setN(r.n);
      else setFehler(r.ok ? null : r.error ?? 'Rahmen-Vorschau fehlgeschlagen.');
    });
  }

  function ziehen() {
    setFehler(null);
    setQueueHinweis(null);
    start(async () => {
      const r = await losZiehenAction({ von, bis, k, backend });
      if (!r.ok || !r.ergebnis) {
        setFehler(!r.ok ? r.error ?? 'Ziehung fehlgeschlagen.' : 'Ziehung fehlgeschlagen.');
        return;
      }
      const erg = r.ergebnis;
      if (erg.status === 'wartet') {
        setPending(erg.pending);
        setQueueHinweis('Der QPU-Job ist eingereiht — Ergebnis später über „Abholen" holen.');
      } else {
        setZiehungen((z) => [erg.ziehung, ...z]);
        setNeueste(erg.ziehung.auditId);
        setPending(null);
      }
    });
  }

  function abholen() {
    setFehler(null);
    setQueueHinweis(null);
    start(async () => {
      const r = await losAbholenAction();
      if (!r.ok || !r.ergebnis) {
        setFehler(!r.ok ? r.error ?? 'Abholen fehlgeschlagen.' : 'Abholen fehlgeschlagen.');
        return;
      }
      const erg = r.ergebnis;
      if (erg.status === 'wartet') {
        setQueueHinweis('Der Job liegt noch in der IBM-Queue — bitte später erneut abholen.');
      } else {
        setZiehungen((z) => [erg.ziehung, ...z]);
        setNeueste(erg.ziehung.auditId);
        setPending(null);
      }
    });
  }

  function pruefen(ziehung: LosZiehung) {
    setPruefBusy(ziehung.auditId);
    start(async () => {
      // Online-Attestierung nur sinnvoll, wenn ein IBM-Job existiert (QPU).
      const r = await losPruefenAction({ auditId: ziehung.auditId, online: !!ziehung.jobId });
      if (r.ok && r.ergebnis) {
        setPruefErgebnisse((p) => ({ ...p, [ziehung.auditId]: r.ergebnis! }));
      } else if (!r.ok) {
        setFehler(r.error ?? 'Prüfung fehlgeschlagen.');
      }
      setPruefBusy(null);
    });
  }

  return (
    <div className="space-y-6">
      {/* Ziehungs-Formular */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
          <Dices className="h-4 w-4 text-brand-700" />
          Neue Stichprobe ziehen
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label" htmlFor="von">Zeitraum von</label>
            <input
              id="von" type="date" className="input text-xs" value={von}
              onChange={(e) => { setVon(e.target.value); aktualisiereVorschau(e.target.value, bis); }}
            />
          </div>
          <div>
            <label className="label" htmlFor="bis">Zeitraum bis</label>
            <input
              id="bis" type="date" className="input text-xs" value={bis}
              onChange={(e) => { setBis(e.target.value); aktualisiereVorschau(von, e.target.value); }}
            />
          </div>
          <div>
            <label className="label" htmlFor="k">Stichprobe (k)</label>
            <input
              id="k" type="number" min={1} max={n ?? 500} className="input text-xs" value={k}
              onChange={(e) => setK(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div>
            <label className="label" htmlFor="backend">Zufallsquelle</label>
            <select
              id="backend" className="input text-xs" value={backend}
              onChange={(e) => setBackend(e.target.value as Backend)}
            >
              {BACKENDS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-xs text-muted mt-2">{backendInfo.hinweis}</p>

        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-secondary">
            Rahmen:{' '}
            {n === null ? (
              <span className="text-disabled">wird ermittelt …</span>
            ) : (
              <>
                <span className="font-semibold">{n}</span> Subsumtion{n === 1 ? '' : 'en'} im Zeitraum
                — es werden ausschließlich IDs an die Engine übertragen.
              </>
            )}
          </p>
          <button
            onClick={ziehen}
            disabled={busy || !!pending || n === null || n === 0 || k > (n ?? 0)}
            className="btn-primary text-xs"
            title={pending ? 'Es wartet noch ein QPU-Job — bitte zuerst abholen.' : undefined}
          >
            <Dices className="h-4 w-4" />
            {busy ? 'Zieht …' : 'Stichprobe ziehen'}
          </button>
        </div>
        {fehler && <p className="text-xs text-red-600 mt-2">{fehler}</p>}
      </div>

      {/* Wartender QPU-Job */}
      {pending && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4">
          <div className="flex items-start gap-3">
            <Hourglass className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-yellow-900">QPU-Job wartet in der IBM-Queue</p>
              <p className="text-xs text-yellow-800 mt-1">
                Job-ID <Mono value={pending.jobId} max={40} /> · Commitment{' '}
                <Mono value={pending.commitment} /> · k={pending.k} aus n={pending.rahmen.length} ·
                beantragt {fmtDateTimeShort(new Date(pending.beantragtAm))}
              </p>
              {queueHinweis && <p className="text-xs text-yellow-800 mt-1">{queueHinweis}</p>}
            </div>
            <button onClick={abholen} disabled={busy} className="btn-secondary text-xs">
              <RefreshCw className="h-3.5 w-3.5" />
              {busy ? 'Holt ab …' : 'Abholen'}
            </button>
          </div>
        </div>
      )}

      {/* Historie inkl. frischem Ergebnis */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-default">
          <h2 className="text-sm font-semibold text-primary">Ziehungen</h2>
          <p className="text-xs text-muted">
            Jede Ziehung ist als Audit-Event in der Hash-Chain verankert (Aktion{' '}
            <code className="font-mono">risk.los.gezogen</code>).
          </p>
        </div>
        {ziehungen.length === 0 ? (
          <p className="px-5 py-12 text-sm text-disabled text-center">Noch keine Ziehungen.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {ziehungen.map((z) => {
              const pruef = pruefErgebnisse[z.auditId];
              return (
                <li key={z.auditId} className={`p-5 ${z.auditId === neueste ? 'bg-brand-50/40' : ''}`}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <QuelleBadge quelleKlasse={z.quelleKlasse} />
                        <span className="text-sm font-medium text-primary">
                          k={z.k} aus n={z.n}
                        </span>
                        <span className="text-xs text-muted">
                          {fmtDateTimeShort(new Date(z.gezogenAm))}
                          {z.zeitraum ? ` · Zeitraum ${z.zeitraum.von} – ${z.zeitraum.bis}` : ''}
                        </span>
                      </div>
                      <div className="text-xs text-secondary space-x-3">
                        <span>Commitment: <Mono value={z.commitment} /></span>
                        {z.jobId && <span>IBM-Job: <Mono value={z.jobId} max={40} /></span>}
                        {z.rohCountsSha256 && <span>Roh-Counts: <Mono value={z.rohCountsSha256} max={16} /></span>}
                        <span className="text-muted">{z.extraktor} → {z.drbg}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        onClick={() => pruefen(z)}
                        disabled={pruefBusy === z.auditId}
                        className="btn-secondary text-xs"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {pruefBusy === z.auditId ? 'Prüft …' : 'Nachweis prüfen'}
                      </button>
                      {pruef && (
                        <span
                          className={`flex items-center gap-1 text-xs ${pruef.gueltig ? 'text-green-700' : 'text-red-700'}`}
                        >
                          {pruef.gueltig ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                          {pruef.gueltig ? 'gültig' : 'UNGÜLTIG'}
                          {pruef.geprueft.length > 0 && (
                            <span className="text-muted">({pruef.geprueft.join(', ')})</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Stichprobe */}
                  <ul className="mt-3 space-y-1">
                    {z.stichprobe.map((s) => (
                      <li key={s.analysisId} className="text-xs flex items-center gap-2">
                        <span className="text-disabled font-mono">{s.analysisId.slice(0, 8)}…</span>
                        {s.clientId && !s.geloescht ? (
                          <Link
                            href={`/staff/clients/${s.clientId}/subsumtion/${s.analysisId}`}
                            className="text-brand-700 hover:underline"
                          >
                            {s.titel ?? 'Subsumtion öffnen'}
                          </Link>
                        ) : (
                          <span className="text-secondary">{s.titel ?? 'Subsumtion'}</span>
                        )}
                        {s.geloescht && <span className="badge badge-red">gelöscht</span>}
                        {!s.clientId && !s.geloescht && (
                          <span className="badge badge-gray">ohne Mandantenbezug</span>
                        )}
                      </li>
                    ))}
                  </ul>

                  {(z.hinweise.length > 0 || (pruef && pruef.hinweise.length > 0)) && (
                    <ul className="mt-2 space-y-0.5">
                      {[...z.hinweise, ...(pruef?.hinweise ?? [])].map((hint, i) => (
                        <li key={i} className="text-xs text-muted">· {hint}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
