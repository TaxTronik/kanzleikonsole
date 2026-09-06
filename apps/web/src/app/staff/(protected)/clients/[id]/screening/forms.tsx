'use client';
import { useState } from 'react';
import { recordPepResearchAction, reviewScreeningAction, runEuScreeningAction } from './actions';
const field = 'block w-full rounded border border-default bg-surface px-3 py-2';
const sources = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
function ReviewFields({ pep }: { pep: boolean }) {
  return (
    <>
      <label>
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
      <label>
        Begründung / Rechercheumfang
        <textarea name="note" required minLength={10} maxLength={4000} className={field} />
      </label>
      <label>
        Quellen-URLs, eine je Zeile
        <textarea name="sources" required className={field} placeholder="https://…" />
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
      className="space-y-3 rounded-lg border border-default p-4"
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
      <h2 className="font-semibold">Neue Prüfung dokumentieren</h2>
      {context?.status === 'IN_REVIEW' ? (
        <label>
          Bindung an aktuelle GwG-Fassung
          <select name="targetKey" className={field}>
            <option value="">Freier Nachweis (erfüllt keine GwG-Freigabesperre)</option>
            {context.targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} · {t.role}
              </option>
            ))}
          </select>
          <span className="text-sm">
            Bei Bindung werden Name und Geburtsdatum aus der aktuellen GwG-Fassung übernommen. Freie
            Werte unten ändern diese Person nicht.
          </span>
        </label>
      ) : (
        <p>
          Für freigaberelevante Nachweise zuerst die GwG-Fassung zur Berufsträgerprüfung einreichen.
          Freie Nachweise bleiben separat.
        </p>
      )}
      <label>
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
      <label>
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
      <label>
        Rolle im Mandat
        <input
          className={field}
          name="role"
          required
          maxLength={160}
          placeholder="Mandant / gesetzliche Vertretung / wirtschaftlich Berechtigter"
        />
      </label>
      <label>
        Geburtsdatum, soweit bekannt
        <input type="date" className={field} name="birthDate" />
      </label>
      {mode === 'PEP' && <ReviewFields pep />}
      <button
        disabled={pending}
        className="rounded bg-primary px-4 py-2 text-white disabled:opacity-50"
      >
        {pending
          ? 'Wird gespeichert …'
          : mode === 'EU'
            ? 'Lokal abgleichen'
            : 'Recherche speichern'}
      </button>
      <p role="status" className="text-sm">
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
    <details className="mt-3">
      <summary>Beurteilung als neuen Nachweis ergänzen</summary>
      <form
        className="space-y-3 mt-3"
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
        <button disabled={pending} className="rounded border px-3 py-2">
          Ergänzung speichern
        </button>
        <p role="status">{message}</p>
      </form>
    </details>
  );
}
