'use client';
import { useState } from 'react';
import { refreshScreeningSourceAction } from './actions';
export function RefreshScreeningForm() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <form
      action={async () => {
        setPending(true);
        try {
          const r = await refreshScreeningSourceAction();
          setMessage(
            r.ok
              ? 'Quelle erfolgreich geprüft. Automatische Folgeprüfungen werden mit dem nächsten täglichen Lauf ergänzt.'
              : r.error,
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <button disabled={pending} className="rounded border px-4 py-2">
        {pending ? 'Offizielle Liste wird geladen …' : 'EU-Liste jetzt abrufen'}
      </button>
      <p role="status" className="mt-2">
        {message}
      </p>
    </form>
  );
}
