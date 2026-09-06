'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FormErrorSummary } from '@/components/form-errors';
import type { ActionResult } from '@/server/actions/types';
import {
  assignInboxThreadAction,
  claimInboxThreadAction,
  reopenInboxThreadAction,
  replyInboxThreadAction,
  resolveInboxThreadAction,
} from './actions';

interface StaffOption {
  id: string;
  name: string;
}

export function InboxStaffControls({
  threadId,
  status,
  assignedStaffId,
  currentStaffId,
  staff,
}: {
  threadId: string;
  status: 'OPEN' | 'RESOLVED';
  assignedStaffId: string | null;
  currentStaffId: string;
  staff: StaffOption[];
}) {
  const router = useRouter();
  const mutationId = useRef(crypto.randomUUID());
  const [state, setState] = useState<ActionResult & { mailWarning?: string }>({ ok: true });
  const [busy, setBusy] = useState(false);

  async function run(action: (form: FormData) => Promise<ActionResult>, form: FormData) {
    setBusy(true);
    try {
      const result = await action(form);
      setState(result);
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    form.set('threadId', threadId);
    form.set('clientMutationId', mutationId.current);
    setBusy(true);
    try {
      const result = await replyInboxThreadAction(form);
      setState(result);
      if (result.ok) {
        mutationId.current = crypto.randomUUID();
        event.currentTarget.reset();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <FormErrorSummary
        error={state.ok ? undefined : state.error}
        fieldErrors={state.fieldErrors}
      />
      {state.mailWarning ? (
        <p role="status" className="alert-warning text-sm">
          {state.mailWarning}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        {status === 'OPEN' && !assignedStaffId ? (
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => {
              const form = new FormData();
              form.set('threadId', threadId);
              void run(claimInboxThreadAction, form);
            }}
          >
            Übernehmen
          </button>
        ) : null}
        {status === 'OPEN' ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(assignInboxThreadAction, new FormData(event.currentTarget));
            }}
          >
            <input type="hidden" name="threadId" value={threadId} />
            <label className="text-sm">
              <span className="label">Zuweisung</span>
              <select className="input" name="staffId" defaultValue={assignedStaffId ?? ''}>
                <option value="">Teamkorb</option>
                {staff.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.id === currentStaffId ? ' (ich)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-secondary" disabled={busy}>
              Zuweisen
            </button>
          </form>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            const form = new FormData();
            form.set('threadId', threadId);
            void run(status === 'OPEN' ? resolveInboxThreadAction : reopenInboxThreadAction, form);
          }}
        >
          {status === 'OPEN' ? 'Als erledigt markieren' : 'Wieder öffnen'}
        </button>
      </div>

      {status === 'OPEN' ? (
        <form onSubmit={reply} className="space-y-3">
          <label htmlFor="staff-inbox-reply" className="label">
            Antwort an den Mandanten
          </label>
          <textarea
            id="staff-inbox-reply"
            name="body"
            className="input min-h-32 w-full"
            required
            maxLength={10000}
          />
          <p className="text-xs text-muted">
            Die E-Mail enthält nur einen neutralen Aktivitätshinweis; der Nachrichtentext bleibt im
            Portal.
          </p>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Wird gespeichert …' : 'Antwort speichern und Hinweis senden'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
