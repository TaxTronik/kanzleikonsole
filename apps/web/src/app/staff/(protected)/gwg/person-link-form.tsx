'use client';
import { useActionState } from 'react';
import { changePersonLinkAction } from './actions';
import type { VisiblePersonLink } from '@/server/gwg/control-list-model';
type Person = { id: string; name: string; clientName: string };
export function PersonLinkForm({
  people,
  links,
}: {
  people: Person[];
  links: VisiblePersonLink[];
}) {
  const [state, action, pending] = useActionState(changePersonLinkAction, null);
  const names = new Map(
    people.map((person) => [person.id, `${person.name} — ${person.clientName}`]),
  );
  return (
    <details className="card p-4">
      <summary className="cursor-pointer font-medium">
        Personen ausdrücklich verknüpfen oder Verbindung lösen
      </summary>
      <p className="mt-3 text-sm text-muted">
        Bestätigen Sie nur bekannte Personenidentität. Angaben, Ausweise und GwG-Freigaben bleiben
        je Mandat getrennt. Gleiche Namen werden nicht automatisch verbunden.
      </p>
      <form action={action} className="mt-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          {(['left', 'right'] as const).map((key, index) => (
            <div key={key}>
              <label className="label" htmlFor={`person-link-${key}`}>
                Person {index + 1}
              </label>
              <select
                id={`person-link-${key}`}
                name={key}
                className="input"
                defaultValue=""
                required
              >
                <option value="" disabled>
                  Person und Mandant wählen
                </option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} — {person.clientName}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input name="confirmed" type="checkbox" required />
          Ich bestätige: Die ausgewählten Einträge gehören zu derselben Person.
        </label>
        <button className="btn-primary" disabled={pending || people.length < 2}>
          {pending ? 'Speichert…' : 'Verknüpfen'}
        </button>
      </form>
      {state && !state.ok && (
        <p role="alert" className="alert-error-sm mt-3">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-sm mt-3">
          Die Verknüpfung wurde gespeichert.
        </p>
      )}
      {links.length > 0 && (
        <ul className="mt-4 space-y-3 border-t border-subtle pt-4">
          {links.map((link) => (
            <li key={link.id} className="text-sm">
              <RemoveLink
                link={link}
                label={`${names.get(link.fromAnchorId)} ↔ ${names.get(link.toAnchorId)}`}
              />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
function RemoveLink({ link, label }: { link: VisiblePersonLink; label: string }) {
  const [state, action, pending] = useActionState(changePersonLinkAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="left" value={link.fromAnchorId} />
      <input type="hidden" name="right" value={link.toAnchorId} />
      <input type="hidden" name="remove" value="true" />
      <span className="flex-1">{label}</span>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="confirmed" required />
        Verbindung lösen
      </label>
      <button className="btn-secondary text-xs" disabled={pending}>
        {pending ? 'Speichert…' : 'Bestätigen'}
      </button>
      {state && !state.ok && (
        <span role="alert" className="text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}
