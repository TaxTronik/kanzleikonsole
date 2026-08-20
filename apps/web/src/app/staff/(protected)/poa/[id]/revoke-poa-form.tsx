'use client';

import { useActionState, useState } from 'react';
import { Send, X } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { revokePoaAction, sendForSignatureAction, type ActionResult } from '../actions';

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function sendPoa(_previous: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    return await sendForSignatureAction(formData);
  } catch (error) {
    return {
      ok: false,
      error: actionError(error, 'Die Vollmacht konnte nicht versendet werden.'),
    };
  }
}

export function SendPoaForm({
  poaId,
  isResend,
  expectedUpdatedAt,
}: {
  poaId: string;
  isResend: boolean;
  expectedUpdatedAt: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(sendPoa, null);

  return (
    <form action={formAction}>
      <input type="hidden" name="poaId" value={poaId} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <button type="submit" className="btn-primary" disabled={pending}>
        <Send className="h-4 w-4" />
        {pending ? 'Versende…' : isResend ? 'Erneut senden' : 'Zur Unterschrift senden'}
      </button>
      {state && !state.ok && (
        <p role="alert" className="mt-2 max-w-sm text-xs text-red-700">
          {state.error ?? 'Die Vollmacht konnte nicht versendet werden.'}
        </p>
      )}
    </form>
  );
}

export function RevokePoaForm({ poaId, subject }: { poaId: string; subject: string }) {
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = `poa-revoke-reason-${poaId}`;
  const hintId = `${reasonId}-hint`;
  const trimmedReason = reason.trim();

  async function revoke(): Promise<{ ok: boolean; error?: string }> {
    const formData = new FormData();
    formData.set('poaId', poaId);
    formData.set('reason', trimmedReason);

    try {
      await revokePoaAction(formData);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: actionError(error, 'Die Vollmacht konnte nicht widerrufen werden.'),
      };
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <label className="label" htmlFor={reasonId}>
        Widerrufsgrund
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={reasonId}
          name="reason"
          type="text"
          className="input min-w-0 flex-1"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={hintId}
          required
          minLength={1}
          maxLength={2000}
        />
        <button
          type="button"
          className="btn-secondary shrink-0 border-red-300 text-red-700 hover:bg-red-50"
          disabled={!trimmedReason}
          onClick={() => setConfirmOpen(true)}
        >
          <X className="h-4 w-4" />
          Widerrufen
        </button>
      </div>
      <p id={hintId} className="mt-2 text-xs text-muted">
        Der Grund wird als Widerrufsnachweis gespeichert. Gegenüber der Finanzbehörde wird der
        Widerruf erst mit Zugang wirksam (§ 80 Abs. 1 Satz 3 AO). Wurden die Vollmachtsdaten
        elektronisch übermittelt, muss der Bevollmächtigte den Widerruf den Landesfinanzbehörden
        unverzüglich nach amtlich vorgeschriebenem Datensatz mitteilen (§ 80a Abs. 1 Satz 4 AO).
      </p>

      {confirmOpen && (
        <ConfirmModal
          danger
          title="Vollmacht widerrufen"
          message={
            <>
              <p>
                Die Vollmacht „{subject}“ wirklich widerrufen? Der Signatur-Link wird sofort
                ungültig. Dieser Schritt lässt sich in der Anwendung nicht rückgängig machen.
              </p>
              <p className="mt-2 font-medium text-primary">Grund: {trimmedReason}</p>
            </>
          }
          confirmLabel="Verbindlich widerrufen"
          busyLabel="Widerrufe…"
          onConfirm={revoke}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
