'use client';
import { useState } from 'react';
import { recordPepResearchAction, reviewScreeningAction, runEuScreeningAction } from './actions';
const field = 'input mt-1';
const sources = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
function ReviewFields({ pep }: { pep: boolean }) {
  return (
    <>
      <label className="label">
        Dokumentiertes Ergebnis
        <select name="outcome" className={field} defaultValue="UNRESOLVED">
          <option value="UNRESOLVED">Offen / weitere Prüfung nötig</option>
          {pep ? (
            <>
              <option value="PEP_FOUND">PEP-Hinweis gefunden</option>
              <option value="PEP_NOT_FOUND">Bei dieser Recherche kein PEP-Hinweis gefunden</option>
            </>
          ) : (
            <>
              <option value="FALSE_POSITIVE">Namensähnlichkeit geklärt: andere Person</option>
              <option value="CONFIRMED">
                Übereinstimmung bestätigt – weitere Maßnahmen prüfen
              </option>
            </>
          )}
        </select>
      </label>
      <label className="label">
        Begründung / Rechercheumfang
        <textarea name="note" required minLength={10} maxLength={4000} rows={3} className={field} />
      </label>
      <label className="label">
        Quellen-URLs, eine je Zeile
        <textarea name="sources" required rows={3} className={field} placeholder="https://…" />
      </label>
    </>
  );
}
export function ScreeningForms({
  clientId,
  defaultName,
  context,
}: {
  clientId: string;
  defaultName: string;
  context: {
    hash: string;
    status: string;
    targets: Array<{ key: string; name: string; role: string }>;
  } | null;
}) {
  const [mode, setMode] = useState<'EU' | 'PEP'>('EU');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <form
      className="card space-y-4 p-5"
      action={async (fd) => {
        setPending(true);
        setMessage('');
        try {
          const subject = {
            targetKey: String(fd.get('targetKey') ?? '') || undefined,
            contextHash: context?.hash,
            name: String(fd.get('name')),
            role: String(fd.get('role')),
            birthDate: String(fd.get('birthDate') ?? '') || undefined,
          };
          const result =
            mode === 'EU'
              ? await runEuScreeningAction(clientId, subject)
              : await recordPepResearchAction(clientId, subject, {
                  outcome: fd.get('outcome'),
                  note: fd.get('note'),
                  sources: sources(fd.get('sources')),
                });
          setMessage(
            result.ok
              ? 'Unveränderlicher Nachweis gespeichert. Die GwG-Freigabe wurde nicht geändert.'
              : (result.error ?? 'Speichern fehlgeschlagen.'),
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <h2 className="font-semibold text-primary">Neue Prüfung dokumentieren</h2>
      {context?.status === 'IN_REVIEW' ? (
        <label className="label">
          Bindung an aktuelle GwG-Fassung
          <select name="targetKey" className={field}>
            <option value="">Freier Nachweis (erfüllt keine GwG-Freigabesperre)</option>
            {context.targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} · {t.role}
              </option>
            ))}
          </select>
          <span className="mt-2 block text-sm font-normal leading-relaxed text-muted">
            Bei Bindung werden Name und Geburtsdatum aus der aktuellen GwG-Fassung übernommen. Freie
            Werte unten ändern diese Person nicht.
          </span>
        </label>
      ) : (
        <p className="text-sm leading-relaxed text-muted">
          Für freigaberelevante Nachweise zuerst die GwG-Fassung zur Berufsträgerprüfung einreichen.
          Freie Nachweise bleiben separat.
        </p>
      )}
      <label className="label">
        Prüfart
        <select
          className={field}
          value={mode}
          onChange={(e) => setMode(e.target.value as 'EU' | 'PEP')}
        >
          <option value="EU">Lokale EU-Sanktionsliste</option>
          <option value="PEP">Manuelle PEP-Recherche</option>
        </select>
      </label>
      <label className="label">
        Name / Firma
        <input
          className={field}
          name="name"
          defaultValue={defaultName}
          required
          minLength={2}
          maxLength={250}
        />
      </label>
      <label className="label">
        Rolle im Mandat
        <input
          className={field}
          name="role"
          required
          maxLength={160}
          placeholder="Mandant / gesetzliche Vertretung / wirtschaftlich Berechtigter"
        />
      </label>
      <label className="label">
        Geburtsdatum, soweit bekannt
        <input type="date" className={field} name="birthDate" />
      </label>
      {mode === 'PEP' && <ReviewFields pep />}
      <button disabled={pending} className="btn-primary">
        {pending
          ? 'Wird gespeichert …'
          : mode === 'EU'
            ? 'Lokal abgleichen'
            : 'Recherche speichern'}
      </button>
      <p role="status" className={message ? 'text-sm text-secondary' : 'sr-only'}>
        {message}
      </p>
    </form>
  );
}
export function ScreeningReviewForm({
  clientId,
  runId,
  pep,
}: {
  clientId: string;
  runId: string;
  pep: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <details className="border-t border-default pt-4">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        Beurteilung als neuen Nachweis ergänzen
      </summary>
      <form
        className="space-y-4 mt-4"
        action={async (fd) => {
          setPending(true);
          try {
            const r = await reviewScreeningAction(clientId, runId, {
              outcome: fd.get('outcome'),
              note: fd.get('note'),
              sources: sources(fd.get('sources')),
            });
            setMessage(
              r.ok
                ? 'Ergänzung gespeichert. Vorherige Nachweise bleiben erhalten.'
                : (r.error ?? 'Speichern fehlgeschlagen.'),
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <ReviewFields pep={pep} />
        <button disabled={pending} className="btn-secondary">
          Ergänzung speichern
        </button>
        <p role="status" className={message ? 'text-sm text-secondary' : 'sr-only'}>
          {message}
        </p>
      </form>
    </details>
  );
}
