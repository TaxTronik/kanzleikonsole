'use client';

// Ziehungen des Quantenlos-Panels: wartender QPU-Job und Historie mit
// „Nachweis prüfen" (TCMS-SAMPLE-PROOF-001). Reine Anzeige; Aktionen und
// Zustand kommen aus quantenlos-hooks.ts.

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Hourglass, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { LosPruefErgebnis, LosRahmenTyp, LosZiehung, PendingLos } from '@/server/risk';

function QuelleBadge({ quelleKlasse }: { quelleKlasse: string }) {
  if (quelleKlasse === 'qpu') return <span className="badge badge-purple">QPU (attestierbar)</span>;
  if (quelleKlasse === 'simulator')
    return <span className="badge badge-yellow">Simulator — Test</span>;
  return <span className="badge badge-gray">CSPRNG — Fallback</span>;
}

function RahmenTypBadge({ typ }: { typ: LosRahmenTyp }) {
  return typ === 'audit' ? (
    <span className="badge badge-green">Betriebs-Nachschau</span>
  ) : (
    <span className="badge badge-gray">Risk-Review</span>
  );
}

// Langer kryptografischer Wert (Commitment/Hash/Job-ID) — VOLLSTÄNDIG und
// kopierbar statt auf 24 Zeichen abgeschnitten. Bisher war der volle Wert nur
// per Title-Tooltip erreichbar (auf Touch-Geräten gar nicht), was forensische
// Vergleiche zweier Commitments praktisch unmöglich machte.
function HashWert({ label, value }: { label: string; value: string }) {
  const [kopiert, setKopiert] = useState(false);
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-secondary mb-1">{label}</div>
      <div className="flex items-start gap-1.5">
        <code className="rounded-md border border-default bg-surface-sunken px-2 py-1 font-mono text-sm leading-relaxed text-primary break-all">
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
          className="text-disabled hover:text-brand-700 shrink-0 mt-1 dark:hover:text-brand-300"
          title="Wert kopieren"
        >
          {kopiert ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

export function PendingLosCard({
  pending,
  queueHinweis,
  busy,
  onAbholen,
}: {
  pending: PendingLos;
  queueHinweis: string | null;
  busy: boolean;
  onAbholen: () => void;
}) {
  return (
    <div className="alert-warning">
      <div className="flex items-start gap-3">
        <Hourglass className="h-5 w-5 mt-0.5" />
        <div>
          <p className="font-medium">QPU-Job wartet in der IBM-Queue</p>
          <p className="text-xs mt-1">
            k={pending.k} aus n={pending.rahmen.length} · beantragt{' '}
            {fmtDateTimeShort(new Date(pending.beantragtAm))}
          </p>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
            <HashWert label="IBM-Job-ID" value={pending.jobId} />
            <HashWert label="Commitment" value={pending.commitment} />
          </div>
          {queueHinweis && <p className="text-xs mt-1">{queueHinweis}</p>}
        </div>
        <button onClick={onAbholen} disabled={busy} className="btn-secondary text-xs">
          <RefreshCw className="h-3.5 w-3.5" />
          {busy ? 'Holt ab …' : 'Abholen'}
        </button>
      </div>
    </div>
  );
}

export function LosZiehungenListe({
  ziehungen,
  neueste,
  pruefErgebnisse,
  pruefBusy,
  onPruefen,
}: {
  ziehungen: LosZiehung[];
  neueste: string | null;
  pruefErgebnisse: Record<string, LosPruefErgebnis>;
  pruefBusy: string | null;
  onPruefen: (ziehung: LosZiehung) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-default">
        <h2 className="text-sm font-semibold text-primary">Ziehungen</h2>
        <p className="text-xs text-secondary">
          Jede Ziehung ist als Audit-Event in der Hash-Chain verankert (Aktion{' '}
          <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-primary">
            risk.los.gezogen
          </code>
          ).
        </p>
      </div>
      {ziehungen.length === 0 ? (
        <p className="px-5 py-12 text-sm text-disabled text-center">Noch keine Ziehungen.</p>
      ) : (
        <ul className="divide-y divide-border-subtle bg-surface">
          {ziehungen.map((z) => (
            <LosZiehungEintrag
              key={z.auditId}
              ziehung={z}
              pruef={pruefErgebnisse[z.auditId]}
              neueste={neueste}
              pruefBusy={pruefBusy}
              onPruefen={onPruefen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LosZiehungEintrag({
  ziehung: z,
  pruef,
  neueste,
  pruefBusy,
  onPruefen,
}: {
  ziehung: LosZiehung;
  pruef: LosPruefErgebnis | undefined;
  neueste: string | null;
  pruefBusy: string | null;
  onPruefen: (ziehung: LosZiehung) => void;
}) {
  return (
    <li
      className={`p-5 bg-surface ${
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
            <span className="text-xs text-secondary">
              {fmtDateTimeShort(new Date(z.gezogenAm))}
              {z.zeitraum ? ` · Zeitraum ${z.zeitraum.von} – ${z.zeitraum.bis}` : ''}
            </span>
          </div>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 mt-1">
            <HashWert label="Commitment" value={z.commitment} />
            {z.jobId && <HashWert label="IBM-Job-ID" value={z.jobId} />}
            {z.rohCountsSha256 && (
              <HashWert label="Roh-Counts (SHA-256)" value={z.rohCountsSha256} />
            )}
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-secondary mb-1">
                Extraktor / DRBG
              </div>
              <div className="inline-flex rounded-md border border-default bg-surface-sunken px-2 py-1 text-sm text-primary">
                {z.extraktor} &rarr; {z.drbg}
              </div>
            </div>
          </dl>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => onPruefen(z)}
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
              {pruef.gueltig ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              {pruef.gueltig ? 'gültig' : 'UNGÜLTIG'}
              {pruef.geprueft.length > 0 && (
                <span className="text-secondary">({pruef.geprueft.join(', ')})</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Treffer: Subsumtionen (Risk-Review) bzw. Chain-Ereignisse (Nachschau) */}
      <LosTreffer ziehung={z} />

      {(z.hinweise.length > 0 || (pruef && pruef.hinweise.length > 0)) && (
        <ul className="mt-2 space-y-0.5">
          {[...z.hinweise, ...(pruef?.hinweise ?? [])].map((hint, i) => (
            <li key={i} className="text-xs text-secondary">
              · {hint}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Treffer: Subsumtionen (Risk-Review) bzw. Chain-Ereignisse (Nachschau). */
function LosTreffer({ ziehung: z }: { ziehung: LosZiehung }) {
  return z.rahmenTyp === 'audit' ? (
    <ul className="mt-3 space-y-1.5">
      {z.nachschau.map((e) => (
        <li
          key={e.auditId}
          className="flex items-center gap-2 flex-wrap rounded-md border border-default bg-surface-sunken px-2.5 py-1.5 text-sm"
        >
          <span className="font-mono text-muted">#{e.auditId}</span>
          {e.fehlt ? (
            <span
              className="badge badge-red"
              title="Chain-Einträge sind unlöschbar — ein fehlender Eintrag ist ein Befund."
            >
              Eintrag fehlt!
            </span>
          ) : (
            <>
              <span className="font-medium text-primary">{e.label}</span>
              {e.occurredAt && (
                <span className="text-secondary">{fmtDateTimeShort(new Date(e.occurredAt))}</span>
              )}
              {e.resourceType && <span className="badge badge-gray">{e.resourceType}</span>}
              <span className="text-secondary">
                {e.actorType === 'STAFF'
                  ? 'Staff'
                  : e.actorType === 'CLIENT'
                    ? 'Mandant'
                    : 'System'}
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
          className="flex items-center gap-2 rounded-md border border-default bg-surface-sunken px-2.5 py-1.5 text-sm"
        >
          <span className="font-mono text-muted">{s.analysisId.slice(0, 8)}…</span>
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
  );
}
