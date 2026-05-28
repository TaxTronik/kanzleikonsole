'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FolderInput, Plus, Trash2, ArrowRight, Check } from 'lucide-react';
import {
  createBinderAction,
  updateBinderStatusAction,
  deleteBinderAction,
  type ActionResult,
} from './actions';

const dateFmt = new Intl.DateTimeFormat('de-DE');

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

const STATUS_LABELS: Record<BinderStatus, string> = {
  PREPARED: 'Vorbereitet',
  WITH_CLIENT: 'Beim Mandanten',
  RETURNED: 'Zurück',
  COMPLETED: 'Abgeschlossen',
};

const STATUS_BADGE: Record<BinderStatus, string> = {
  PREPARED: 'badge-gray',
  WITH_CLIENT: 'badge-yellow',
  RETURNED: 'badge-green',
  COMPLETED: 'badge-gray',
};

const NEXT_STATUS: Record<BinderStatus, BinderStatus | null> = {
  PREPARED: 'WITH_CLIENT',
  WITH_CLIENT: 'RETURNED',
  RETURNED: 'COMPLETED',
  COMPLETED: null,
};

const NEXT_LABEL: Record<BinderStatus, string> = {
  PREPARED: 'Ausgegeben',
  WITH_CLIENT: 'Zurückerhalten',
  RETURNED: 'Abgeschlossen',
  COMPLETED: '',
};

export function BindersBlock({
  clientId,
  initial,
}: {
  clientId: string;
  initial: Binder[];
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createBinderAction,
    null,
  );
  const [isMutating, startMut] = useTransition();
  const [open, setOpen] = useState(false);

  function advance(id: string, next: BinderStatus) {
    startMut(async () => {
      await updateBinderStatusAction({ id, status: next });
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm('Pendelordner löschen?')) return;
    startMut(async () => {
      await deleteBinderAction({ id });
      router.refresh();
    });
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const active = initial.filter((b) => b.status !== 'COMPLETED');
  const completed = initial.filter((b) => b.status === 'COMPLETED');

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <FolderInput className="h-4 w-4 text-disabled" />
          Pendelordner ({active.length})
        </h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn-secondary text-xs inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Neu
        </button>
      </div>

      {open && (
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
              onClick={() => setOpen(false)}
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

      {active.length === 0 ? (
        <p className="px-6 py-6 text-sm text-disabled text-center">Keine aktiven Pendelordner.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {active.map((b) => {
            const due = b.expectedReturnAt ? new Date(b.expectedReturnAt) : null;
            const overdue = b.status === 'WITH_CLIENT' && due !== null && due.getTime() < today.getTime();
            const next = NEXT_STATUS[b.status];
            return (
              <li key={b.id} className="px-6 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-primary inline-flex items-center gap-2">
                      {b.label}
                      <span className={`${STATUS_BADGE[b.status]} text-[10px]`}>
                        {STATUS_LABELS[b.status]}
                      </span>
                      {overdue && <span className="badge-red text-[10px]">überfällig</span>}
                    </p>
                    {b.contents && (
                      <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">{b.contents}</p>
                    )}
                    <p className="text-[11px] text-muted mt-1 flex flex-wrap gap-x-3">
                      {b.sentAt && <span>ausgegeben {dateFmt.format(new Date(b.sentAt))}</span>}
                      {due && (
                        <span className={overdue ? 'text-red-700 font-medium' : ''}>
                          erwartet {dateFmt.format(due)}
                        </span>
                      )}
                      {b.returnedAt && <span>zurück {dateFmt.format(new Date(b.returnedAt))}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {next && (
                      <button
                        type="button"
                        onClick={() => advance(b.id, next)}
                        disabled={isMutating}
                        className="btn-secondary text-[11px] py-1 inline-flex items-center gap-1"
                        title={`Status: ${NEXT_LABEL[b.status]}`}
                      >
                        {next === 'COMPLETED' ? <Check className="h-3 w-3" /> : <ArrowRight className="h-3 w-3" />}
                        {NEXT_LABEL[b.status]}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(b.id)}
                      disabled={isMutating}
                      className="text-disabled hover:text-red-700 p-1"
                      title="Löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {completed.length > 0 && (
        <details className="border-t border-default">
          <summary className="px-6 py-2 text-xs text-muted cursor-pointer">
            {completed.length} abgeschlossen
          </summary>
          <ul className="divide-y divide-border-subtle">
            {completed.map((b) => (
              <li key={b.id} className="px-6 py-2 text-sm text-muted flex justify-between gap-2">
                <span className="truncate">{b.label}</span>
                {b.returnedAt && <span className="text-xs">{dateFmt.format(new Date(b.returnedAt))}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
