'use client';

import { useActionState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { verifyCheckAction, rejectCheckAction, type ActionResult } from './actions';

/**
 * GwG-Decision-Buttons (Verifizieren / Ablehnen) mit useActionState. Zeigt
 * Server-Fehler inline an, statt die Page in einen Runtime-Error zu kippen
 * (z. B. wenn der eingeloggte ADMIN nicht Berufsträger für diesen Mandanten
 * ist — das soll als sichtbare Meldung erscheinen, nicht als 500).
 */
export function GwgDecisionForms({ checkId, clientId }: { checkId: string; clientId: string }) {
  const [verifyState, verifyAction, verifyPending] = useActionState<ActionResult | null, FormData>(
    verifyCheckAction,
    null,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState<ActionResult | null, FormData>(
    rejectCheckAction,
    null,
  );

  // Bei Erfolg revalidiert die Server-Action die Page und der ganze Block
  // (`check.status === 'IN_REVIEW'`) verschwindet automatisch. Nur Fehlermeldungen
  // brauchen wir hier explizit.
  const error = verifyState?.error ?? rejectState?.error ?? null;

  return (
    <>
      <div className="flex gap-3">
        <form action={verifyAction}>
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <button type="submit" className="btn-primary" disabled={verifyPending}>
            <ShieldCheck className="h-4 w-4" />
            {verifyPending ? 'Verifiziere…' : 'Verifizieren und Mandant aktivieren'}
          </button>
        </form>
        <form action={rejectAction} className="flex-1 flex gap-2">
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input
            name="reason"
            type="text"
            className="input flex-1"
            placeholder="Ablehnungsgrund (Pflicht)"
            required
            minLength={1}
            maxLength={2000}
          />
          <button
            type="submit"
            className="btn-secondary text-red-700 border-red-300 hover:bg-red-50"
            disabled={rejectPending}
          >
            {rejectPending ? 'Lehne ab…' : 'Ablehnen'}
          </button>
        </form>
      </div>
      {error && <p className="alert-error-sm mt-3">{error}</p>}
    </>
  );
}
