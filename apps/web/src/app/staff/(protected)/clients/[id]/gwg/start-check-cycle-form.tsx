'use client';

import { useActionState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { startNewCheckCycleAction, type ActionResult } from './actions';

type TerminalStatus = 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export function StartCheckCycleForm({
  clientId,
  checkId,
  status,
}: {
  clientId: string;
  checkId?: string;
  status: TerminalStatus | null;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    startNewCheckCycleAction,
    null,
  );

  function confirmReverification(event: FormEvent<HTMLFormElement>) {
    if (
      status === 'VERIFIED' &&
      !window.confirm(
        'Wiederholungsprüfung wirklich starten? Der bisher verifizierte Mandant wird bis zur erneuten Berufsträger-Freigabe deaktiviert.',
      )
    ) {
      event.preventDefault();
    }
  }

  const label =
    status === null
      ? 'Prüfung manuell starten'
      : status === 'REJECTED'
        ? 'Korrekturprüfung starten'
        : 'Wiederholungsprüfung starten';
  const Icon = status === null ? ShieldCheck : RefreshCw;

  return (
    <div>
      <form action={formAction} onSubmit={confirmReverification}>
        <input type="hidden" name="clientId" value={clientId} />
        {checkId && <input type="hidden" name="expectedLatestCheckId" value={checkId} />}
        <button type="submit" className="btn-primary" disabled={isPending}>
          <Icon className="h-4 w-4" />
          {isPending ? 'Prüfzyklus wird vorbereitet…' : label}
        </button>
      </form>
      {state && !state.ok && state.error && (
        <p role="alert" className="alert-error-sm mt-3">
          {state.error}
        </p>
      )}
    </div>
  );
}
