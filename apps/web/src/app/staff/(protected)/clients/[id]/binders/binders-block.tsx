'use client';

import { useActionState } from 'react';
import { FolderInput } from 'lucide-react';

import { fmtDateShort } from '@/lib/fmt';
import type { ActionResult } from '@/server/actions/staff-action';

import { ClientStatusFlowCard, type ClientStatusFlowDefinition } from '../status-flow-card';
import { createBinderAction, deleteBinderAction, updateBinderStatusAction } from './actions';

type BinderStatus = 'PREPARED' | 'WITH_CLIENT' | 'RETURNED' | 'COMPLETED';

interface Binder {
  id: string;
  label: string;
  contents: string | null;
  status: BinderStatus;
  expectedReturnAt: string | null;
  sentAt: string | null;
  returnedAt: string | null;
}

const BINDER_FLOW = {
  terminalStatus: 'COMPLETED',
  labels: {
    PREPARED: 'Vorbereitet',
    WITH_CLIENT: 'Beim Mandanten',
    RETURNED: 'Zurück',
    COMPLETED: 'Abgeschlossen',
  },
  badgeClasses: {
    PREPARED: 'badge-gray',
    WITH_CLIENT: 'badge-yellow',
    RETURNED: 'badge-green',
    COMPLETED: 'badge-gray',
  },
  next: {
    PREPARED: 'WITH_CLIENT',
    WITH_CLIENT: 'RETURNED',
    RETURNED: 'COMPLETED',
    COMPLETED: null,
  },
  transitionLabels: {
    PREPARED: 'Ausgegeben',
    WITH_CLIENT: 'Zurückerhalten',
    RETURNED: 'Abgeschlossen',
    COMPLETED: '',
  },
} satisfies ClientStatusFlowDefinition<BinderStatus>;

export function BindersBlock({ clientId, initial }: { clientId: string; initial: Binder[] }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createBinderAction,
    null,
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const isOverdue = (binder: Binder) => {
    const due = binder.expectedReturnAt ? new Date(binder.expectedReturnAt) : null;
    return binder.status === 'WITH_CLIENT' && due !== null && due.getTime() < today.getTime();
  };

  return (
    <ClientStatusFlowCard<BinderStatus, Binder>
      title="Pendelordner"
      icon={FolderInput}
      items={initial}
      flow={BINDER_FLOW}
      emptyText="Keine aktiven Pendelordner."
      updateStatus={(id, status) => updateBinderStatusAction({ id, status })}
      deleteItem={(id) => deleteBinderAction({ id })}
      confirmDelete={() => confirm('Pendelordner löschen?')}
      transitionTitle={(_binder, _next, label) => `Status: ${label}`}
      renderCreateForm={(close) => (
        <form
          action={formAction}
          className="p-4 border-b border-default bg-gray-50/50 dark:bg-gray-900/30 space-y-2"
        >
          <input type="hidden" name="clientId" value={clientId} />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              name="label"
              placeholder='Bezeichnung — z. B. „Belege 2025 Q4"'
              className="input text-sm col-span-2"
              maxLength={200}
              required
            />
            <input
              type="date"
              name="expectedReturnAt"
              className="input text-sm"
              min={new Date().toISOString().slice(0, 10)}
              title="Erwartete Rückgabe"
            />
          </div>
          <textarea
            name="contents"
            placeholder='Inhalt (optional) — z. B. „2× DIN-A4-Ordner Rechnungen, 1× Kontoauszüge"'
            rows={2}
            maxLength={4000}
            className="input text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="btn-secondary text-xs"
            >
              Abbrechen
            </button>
            <button type="submit" disabled={isPending} className="btn-primary text-xs">
              {isPending ? 'Lege an…' : 'Anlegen'}
            </button>
          </div>
          {state && !state.ok && <p className="text-xs text-red-700">{state.error}</p>}
        </form>
      )}
      renderStatusAdornment={(binder) =>
        isOverdue(binder) ? <span className="badge-red text-[10px]">überfällig</span> : null
      }
      renderMeta={(binder) => {
        const due = binder.expectedReturnAt ? new Date(binder.expectedReturnAt) : null;
        const overdue = isOverdue(binder);
        return (
          <p className="text-[11px] text-muted mt-1 flex flex-wrap gap-x-3">
            {binder.sentAt && <span>ausgegeben {fmtDateShort(new Date(binder.sentAt))}</span>}
            {due && (
              <span className={overdue ? 'text-red-700 font-medium' : ''}>
                erwartet {fmtDateShort(due)}
              </span>
            )}
            {binder.returnedAt && <span>zurück {fmtDateShort(new Date(binder.returnedAt))}</span>}
          </p>
        );
      }}
      completedSummary={(count) => `${count} abgeschlossen`}
      renderCompletedMeta={(binder) =>
        binder.returnedAt ? (
          <span className="text-xs">{fmtDateShort(new Date(binder.returnedAt))}</span>
        ) : null
      }
    />
  );
}
