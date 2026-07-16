'use client';

import { useActionState, useCallback, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { startNewCheckCycleAction, type ActionResult } from './actions';
import { sendInviteAction } from './invite-actions';

type TerminalStatus = 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export function StartCheckCycleForm({
  clientId,
  checkId,
  status,
  contacts = [],
}: {
  clientId: string;
  checkId?: string;
  status: TerminalStatus | null;
  contacts?: Array<{ fullName: string; email: string }>;
}) {
  const [sendInvite, setSendInvite] = useState(false);
  const [contactIndex, setContactIndex] = useState(0);
  const action = useCallback(async (_previous: CycleResult | null, formData: FormData) => {
    const cycle = await startNewCheckCycleAction(null, formData);
    if (!cycle.ok || formData.get('sendInvite') !== 'on') return cycle;

    const invite = await sendInviteAction({
      clientId: String(formData.get('clientId') ?? ''),
      inviteName: String(formData.get('inviteName') ?? ''),
      inviteEmail: String(formData.get('inviteEmail') ?? ''),
      gwgCheckId: cycle.checkId,
    });
    return invite.ok
      ? { ...cycle, inviteLink: invite.link }
      : {
          ...cycle,
          warning:
            invite.error ??
            'Der Prüfzyklus wurde gestartet, die Einladung konnte jedoch nicht versendet werden.',
        };
  }, []);
  const [state, formAction, isPending] = useActionState<CycleResult | null, FormData>(action, null);

  function confirmReverification(event: FormEvent<HTMLFormElement>) {
    if (
      status === 'VERIFIED' &&
      !window.confirm(
        'Änderungsprüfung wirklich starten? Der bisher verifizierte Snapshot bleibt als Pflichtaufzeichnung erhalten. Der Mandant wird bis zur erneuten Berufsträger-Freigabe deaktiviert.',
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
        : status === 'VERIFIED'
          ? 'Änderung erfassen und Prüfung neu starten'
          : 'Wiederholungsprüfung starten';
  const Icon = status === null ? ShieldCheck : RefreshCw;

  return (
    <div>
      <form action={formAction} onSubmit={confirmReverification} className="space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        {checkId && <input type="hidden" name="expectedLatestCheckId" value={checkId} />}
        {status === 'VERIFIED' && (
          <div>
            <label className="label" htmlFor={`gwg-change-scope-${checkId}`}>
              Startanlass des neuen Prüfzyklus
            </label>
            <select
              id={`gwg-change-scope-${checkId}`}
              name="changeScope"
              className="input"
              defaultValue="BOTH"
              required
            >
              <option value="BENEFICIAL_OWNERS">Wirtschaftlich Berechtigte</option>
              <option value="REPRESENTATIVES">Gesetzliche Vertretung</option>
              <option value="BOTH">Berechtigte und Vertretung / noch unklar</option>
              <option value="ROUTINE">Turnusmäßige Wiederholungsprüfung</option>
            </select>
            <p className="mt-1 text-xs text-muted">
              Dieser Startanlass bleibt unverändert. Weitere Änderungen innerhalb des laufenden
              Zyklus werden im Audit-Protokoll erfasst. Änderungen erfolgen ausschließlich im neuen
              Snapshot.
            </p>
          </div>
        )}
        {status === 'VERIFIED' && contacts.length > 0 && (
          <div className="rounded-md border border-default bg-subtle p-3">
            <label className="flex items-start gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                name="sendInvite"
                className="mt-1"
                checked={sendInvite}
                onChange={(event) => setSendInvite(event.target.checked)}
              />
              <span>
                Neue Angaben und Nachweise direkt beim Mandanten anfordern
                <span className="mt-0.5 block text-xs text-muted">
                  Die Einladung ist optional. Ohne Einladung bearbeitet die Kanzlei den neuen
                  Prüfsnapshot selbst.
                </span>
              </span>
            </label>
            {sendInvite && (
              <div className="mt-3">
                <label className="label-sm" htmlFor={`gwg-cycle-contact-${checkId}`}>
                  Empfänger der GwG-Einladung
                </label>
                <select
                  id={`gwg-cycle-contact-${checkId}`}
                  className="input"
                  value={contactIndex}
                  onChange={(event) => setContactIndex(Number(event.target.value))}
                >
                  {contacts.map((contact, index) => (
                    <option key={`${contact.email}:${index}`} value={index}>
                      {contact.fullName} — {contact.email}
                    </option>
                  ))}
                </select>
                <input type="hidden" name="inviteName" value={contacts[contactIndex]?.fullName} />
                <input type="hidden" name="inviteEmail" value={contacts[contactIndex]?.email} />
              </div>
            )}
          </div>
        )}
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
      {state?.ok && state.warning && <p className="alert-error-sm mt-3">{state.warning}</p>}
      {state?.ok && state.inviteLink && (
        <p className="alert-success-sm mt-3">
          Neuer Prüfzyklus und Einladung wurden erstellt. Der bisherige Prüfsnapshot bleibt
          revisionssicher erhalten.
        </p>
      )}
    </div>
  );
}

type CycleResult = ActionResult & { checkId?: string; inviteLink?: string; warning?: string };
