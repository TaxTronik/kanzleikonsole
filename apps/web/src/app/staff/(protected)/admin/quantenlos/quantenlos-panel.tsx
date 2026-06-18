'use client';

// =============================================================================
// Quantenlos-Panel — Rahmen-Vorschau, Ziehen, Abholen (QPU-Queue), Historie
// mit „Nachweis prüfen" + zentrale IBM-Zugangs-Karte. Reine Anzeige-/
// Interaktionsschicht; alles Fachliche läuft über die Server-Actions.
// =============================================================================

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Dices, ShieldCheck, ShieldAlert, RefreshCw, Hourglass, KeyRound, Trash2, Copy, Check } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { LosZiehung, PendingLos, LosPruefErgebnis, LosRahmenTyp } from '@/server/risk';
import type { IbmTokenStatus } from '@/server/settings/quantenlos';
import {
  rahmenVorschauAction,
  losZiehenAction,
  losAbholenAction,
  losPruefenAction,
  ibmTokenSpeichernAction,
  ibmTokenEntfernenAction,
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

const RAHMEN_TYPEN: { value: LosRahmenTyp; label: string; hinweis: string; einheit: [string, string] }[] = [
  {
    value: 'subsumtion',
    label: 'Subsumtionen — Risk-Review',
    hinweis: 'Rahmen: die Subsumtionen des Zeitraums. Je Treffer entsteht eine Review-Wiedervorlage (+14 Tage).',
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

function QuelleBadge({ quelleKlasse }: { quelleKlasse: string }) {
  if (quelleKlasse === 'qpu') return <span className="badge badge-purple">QPU (attestierbar)</span>;
  if (quelleKlasse === 'simulator') return <span className="badge badge-yellow">Simulator — Test</span>;
  return <span className="badge badge-gray">CSPRNG — Fallback</span>;
}

function RahmenTypBadge({ typ }: { typ: LosRahmenTyp }) {
  return typ === 'audit'
    ? <span className="badge badge-green">Betriebs-Nachschau</span>
    : <span className="badge badge-gray">Risk-Review</span>;
}

// Langer kryptografischer Wert (Commitment/Hash/Job-ID) — VOLLSTÄNDIG und
// kopierbar statt auf 24 Zeichen abgeschnitten. Bisher war der volle Wert nur
// per Title-Tooltip erreichbar (auf Touch-Geräten gar nicht), was forensische
// Vergleiche zweier Commitments praktisch unmöglich machte.
function HashWert({ label, value }: { label: string; value: string }) {
  const [kopiert, setKopiert] = useState(false);
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-secondary dark:text-gray-300 mb-1">{label}</div>
      <div className="flex items-start gap-1.5">
        <code className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-sm leading-relaxed text-gray-900 break-all dark:border-gray-600 dark:bg-gray-900 dark:text-white">
          {value}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setKopiert(true);
              setTimeout(() => setKopiert(false), 1200);
            } catch {
              /* Clipboard nicht verfügbar (z. B. unsichere Herkunft) */
            }
          }}
          className="text-disabled hover:text-brand-700 shrink-0 mt-1 dark:text-gray-400 dark:hover:text-brand-300"
          title="Wert kopieren"
        >
          {kopiert ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

interface Props {
  initialZeitraum: { von: string; bis: string };
  initialN: number;
  initialPending: PendingLos | null;
  initialZiehungen: LosZiehung[];
  initialIbmToken: IbmTokenStatus;
}

export function QuantenlosPanel({ initialZeitraum, initialN, initialPending, initialZiehungen, initialIbmToken }: Props) {
  const [von, setVon] = useState(initialZeitraum.von);
  const [bis, setBis] = useState(initialZeitraum.bis);
  const [rahmenTyp, setRahmenTyp] = useState<LosRahmenTyp>('subsumtion');
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

  // IBM-Zugang (zentrale Config) — der Token selbst bleibt im Eingabefeld,
  // zurück kommt nur der maskierte Status.
  const [ibmToken, setIbmToken] = useState<IbmTokenStatus>(initialIbmToken);
  const [tokenEingabe, setTokenEingabe] = useState('');
  const [tokenFehler, setTokenFehler] = useState<string | null>(null);
  const [tokenBusy, startToken] = useTransition();

  const backendInfo = BACKENDS.find((b) => b.value === backend)!;
  const typInfo = RAHMEN_TYPEN.find((t) => t.value === rahmenTyp)!;

  function aktualisiereVorschau(nextVon: string, nextBis: string, nextTyp: LosRahmenTyp) {
    setN(null);
    start(async () => {
      const r = await rahmenVorschauAction({ von: nextVon, bis: nextBis, rahmenTyp: nextTyp });
      if (r.ok && r.n !== undefined) setN(r.n);
      else setFehler(r.ok ? null : r.error ?? 'Rahmen-Vorschau fehlgeschlagen.');
    });
  }

  function ziehen() {
    setFehler(null);
    setQueueHinweis(null);
    start(async () => {
      const r = await losZiehenAction({ von, bis, k, backend, rahmenTyp });
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

  function tokenSpeichern() {
    setTokenFehler(null);
    startToken(async () => {
      const r = await ibmTokenSpeichernAction({ token: tokenEingabe });
      if (r.ok && r.status) {
        setIbmToken(r.status);
        setTokenEingabe('');
      } else if (!r.ok) {
        setTokenFehler(r.error ?? 'Speichern fehlgeschlagen.');
      }
    });
  }

  function tokenEntfernen() {
    setTokenFehler(null);
    startToken(async () => {
      const r = await ibmTokenEntfernenAction();
      if (r.ok && r.status) setIbmToken(r.status);
      else if (!r.ok) setTokenFehler(r.error ?? 'Entfernen fehlgeschlagen.');
    });
  }

  return (
    <div className="space-y-6">
      {/* IBM-Quantum-Zugang — zentrale Config statt Credentials auf der Engine-Maschine */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-brand-700" />
          IBM-Quantum-Zugang
        </h2>
        <p className="text-xs text-muted mb-3">
          Der API-Token (quantum.ibm.com) wird hier AES-256-GCM-verschlüsselt gespeichert und der
          Engine nur pro Ziehung mitgereicht — sie persistiert und loggt ihn nie. Ohne Token nutzt
          die Engine ihren Maschinen-Zugang, falls auf dem Engine-Host hinterlegt.
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
        <div className="flex items-end gap-2 mt-3">
          <div className="flex-1 max-w-md">
            <label className="label" htmlFor="ibm-token">
              {ibmToken.hinterlegt ? 'Token ersetzen' : 'Token hinterlegen'}
            </label>
            <input
              id="ibm-token"
              type="password"
              autoComplete="off"
              className="input text-xs font-mono"
              placeholder="IBM-Quantum-API-Token"
              value={tokenEingabe}
              onChange={(e) => setTokenEingabe(e.target.value)}
            />
          </div>
          <button
            onClick={tokenSpeichern}
            disabled={tokenBusy || tokenEingabe.trim().length < 8}
            className="btn-primary text-xs"
          >
            {tokenBusy ? 'Speichert …' : 'Speichern'}
          </button>
        </div>
        {tokenFehler && <p className="text-xs text-red-600 dark:text-red-300 mt-2">{tokenFehler}</p>}
      </div>

      {/* Ziehungs-Formular */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
          <Dices className="h-4 w-4 text-brand-700" />
          Neue Stichprobe ziehen
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <label className="label" htmlFor="rahmenTyp">Prüfrahmen</label>
            <select
              id="rahmenTyp" className="input text-xs" value={rahmenTyp}
              onChange={(e) => {
                const typ = e.target.value as LosRahmenTyp;
                setRahmenTyp(typ);
                aktualisiereVorschau(von, bis, typ);
              }}
            >
              {RAHMEN_TYPEN.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="von">Zeitraum von</label>
            <input
              id="von" type="date" className="input text-xs" value={von}
              onChange={(e) => { setVon(e.target.value); aktualisiereVorschau(e.target.value, bis, rahmenTyp); }}
            />
          </div>
          <div>
            <label className="label" htmlFor="bis">Zeitraum bis</label>
            <input
              id="bis" type="date" className="input text-xs" value={bis}
              onChange={(e) => { setBis(e.target.value); aktualisiereVorschau(von, e.target.value, rahmenTyp); }}
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

        <p className="text-xs text-muted mt-2">{typInfo.hinweis}</p>
        <p className="text-xs text-muted mt-1">
          {backendInfo.hinweis}
          {backend === 'qpu' && !ibmToken.hinterlegt && (
            <span className="text-yellow-700 dark:text-yellow-300">
              {' '}Kein Token hinterlegt — die Ziehung gelingt nur, wenn der Engine-Host eigene
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
                {n === 1 ? typInfo.einheit[0] : typInfo.einheit[1]} im Zeitraum
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
        {fehler && <p className="text-xs text-red-600 dark:text-red-300 mt-2">{fehler}</p>}
      </div>

      {/* Wartender QPU-Job */}
      {pending && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900/60 dark:bg-yellow-900/20">
          <div className="flex items-start gap-3">
            <Hourglass className="h-5 w-5 text-yellow-600 mt-0.5 dark:text-yellow-300" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-yellow-900 dark:text-yellow-100">QPU-Job wartet in der IBM-Queue</p>
              <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-200">
                k={pending.k} aus n={pending.rahmen.length} · beantragt{' '}
                {fmtDateTimeShort(new Date(pending.beantragtAm))}
              </p>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
                <HashWert label="IBM-Job-ID" value={pending.jobId} />
                <HashWert label="Commitment" value={pending.commitment} />
              </div>
              {queueHinweis && <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-200">{queueHinweis}</p>}
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
        <div className="px-5 py-3 border-b border-default dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-primary">Ziehungen</h2>
          <p className="text-xs text-secondary dark:text-gray-300">
            Jede Ziehung ist als Audit-Event in der Hash-Chain verankert (Aktion{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-primary dark:bg-gray-800 dark:text-white">risk.los.gezogen</code>).
          </p>
        </div>
        {ziehungen.length === 0 ? (
          <p className="px-5 py-12 text-sm text-disabled text-center">Noch keine Ziehungen.</p>
        ) : (
          <ul className="divide-y divide-border-subtle bg-white dark:bg-gray-900">
            {ziehungen.map((z) => {
              const pruef = pruefErgebnisse[z.auditId];
              return (
                <li
                  key={z.auditId}
                  className={`p-5 bg-white dark:bg-gray-800 ${
                    z.auditId === neueste
                      ? 'border-l-2 border-brand-600 bg-brand-50/60 dark:border-brand-400 dark:bg-brand-900/35'
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <QuelleBadge quelleKlasse={z.quelleKlasse} />
                        <RahmenTypBadge typ={z.rahmenTyp} />
                        <span className="text-sm font-medium text-primary">
                          k={z.k} aus n={z.n}
                        </span>
                        <span className="text-xs text-secondary dark:text-gray-300">
                          {fmtDateTimeShort(new Date(z.gezogenAm))}
                          {z.zeitraum ? ` · Zeitraum ${z.zeitraum.von} – ${z.zeitraum.bis}` : ''}
                        </span>
                      </div>
                      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 mt-1">
                        <HashWert label="Commitment" value={z.commitment} />
                        {z.jobId && <HashWert label="IBM-Job-ID" value={z.jobId} />}
                        {z.rohCountsSha256 && <HashWert label="Roh-Counts (SHA-256)" value={z.rohCountsSha256} />}
                        <div className="min-w-0">
                          <div className="text-[11px] uppercase tracking-wide text-secondary dark:text-gray-300 mb-1">Extraktor / DRBG</div>
                          <div className="inline-flex rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white">
                            {z.extraktor} &rarr; {z.drbg}
                          </div>
                        </div>
                      </dl>
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
                          className={`flex items-center gap-1 text-xs ${pruef.gueltig ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}
                        >
                          {pruef.gueltig ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                          {pruef.gueltig ? 'gültig' : 'UNGÜLTIG'}
                          {pruef.geprueft.length > 0 && (
                            <span className="text-secondary dark:text-gray-300">({pruef.geprueft.join(', ')})</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Treffer: Subsumtionen (Risk-Review) bzw. Chain-Ereignisse (Nachschau) */}
                  {z.rahmenTyp === 'audit' ? (
                    <ul className="mt-3 space-y-1.5">
                      {z.nachschau.map((e) => (
                        <li
                          key={e.auditId}
                          className="flex items-center gap-2 flex-wrap rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                        >
                          <span className="font-mono text-gray-500 dark:text-gray-200">#{e.auditId}</span>
                          {e.fehlt ? (
                            <span className="badge badge-red" title="Chain-Einträge sind unlöschbar — ein fehlender Eintrag ist ein Befund.">
                              Eintrag fehlt!
                            </span>
                          ) : (
                            <>
                              <span className="font-medium text-primary">{e.label}</span>
                              {e.occurredAt && (
                                <span className="text-secondary dark:text-gray-200">{fmtDateTimeShort(new Date(e.occurredAt))}</span>
                              )}
                              {e.resourceType && <span className="badge badge-gray">{e.resourceType}</span>}
                              <span className="text-secondary dark:text-gray-200">
                                {e.actorType === 'STAFF' ? 'Staff' : e.actorType === 'CLIENT' ? 'Mandant' : 'System'}
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {z.stichprobe.map((s) => (
                        <li
                          key={s.analysisId}
                          className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                        >
                          <span className="font-mono text-gray-500 dark:text-gray-200">{s.analysisId.slice(0, 8)}…</span>
                          {s.clientId && !s.geloescht ? (
                            <Link
                              href={`/staff/clients/${s.clientId}/subsumtion/${s.analysisId}`}
                              className="text-brand-700 hover:underline dark:text-brand-300"
                            >
                              {s.titel ?? 'Subsumtion öffnen'}
                            </Link>
                          ) : (
                            <span className="text-primary">{s.titel ?? 'Subsumtion'}</span>
                          )}
                          {s.geloescht && <span className="badge badge-red">gelöscht</span>}
                          {!s.clientId && !s.geloescht && (
                            <span className="badge badge-gray">ohne Mandantenbezug</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {(z.hinweise.length > 0 || (pruef && pruef.hinweise.length > 0)) && (
                    <ul className="mt-2 space-y-0.5">
                      {[...z.hinweise, ...(pruef?.hinweise ?? [])].map((hint, i) => (
                        <li key={i} className="text-xs text-secondary dark:text-gray-300">· {hint}</li>
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
