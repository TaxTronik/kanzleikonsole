'use client';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
      <button disabled={pending} className="btn-primary">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {pending ? 'Offizielle Liste wird geladen …' : 'EU-Liste jetzt abrufen'}
      </button>
      <p role="status" className={message ? 'mt-3 text-sm text-secondary' : 'sr-only'}>
        {message}
      </p>
    </form>
  );
}
