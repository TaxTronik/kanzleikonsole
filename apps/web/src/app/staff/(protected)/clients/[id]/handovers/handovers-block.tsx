'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Inbox, Plus, Trash2, ArrowRight, Check, Mail } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { createHandoverAction, updateHandoverStatusAction, deleteHandoverAction } from './actions';
import type { ActionResult } from '@/server/actions/staff-action';

type HandoverStatus = 'RECEIVED' | 'IN_PROGRESS' | 'READY' | 'PICKED_UP';

interface Handover {
  id: string;
  label: string;
  contents: string | null;
  status: HandoverStatus;
  receivedAt: string;
  startedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  notifiedContactEmail: string | null;
}

const STATUS_LABELS: Record<HandoverStatus, string> = {
  RECEIVED: 'Eingegangen',
  IN_PROGRESS: 'In Bearbeitung',
  READY: 'Abholbereit',
  PICKED_UP: 'Abgeholt',
};

const STATUS_BADGE: Record<HandoverStatus, string> = {
  RECEIVED: 'badge-gray',
  IN_PROGRESS: 'badge-yellow',
  READY: 'badge-green',
  PICKED_UP: 'badge-gray',
};

const NEXT_STATUS: Record<HandoverStatus, HandoverStatus | null> = {
  RECEIVED: 'IN_PROGRESS',
  IN_PROGRESS: 'READY',
  READY: 'PICKED_UP',
  PICKED_UP: null,
};

const NEXT_LABEL: Record<HandoverStatus, string> = {
  RECEIVED: 'Bearbeiten',
  IN_PROGRESS: 'Abholbereit melden',
  READY: 'Abgeholt',
  PICKED_UP: '',
};

export function HandoversBlock({ clientId, initial }: { clientId: string; initial: Handover[] }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createHandoverAction,
    null,
  );
  const [isMutating, startMut] = useTransition();
  const [open, setOpen] = useState(false);

  function advance(id: string, next: HandoverStatus, label: string) {
    if (
      next === 'READY' &&
      !confirm(`„${label}" als abholbereit melden? Der Mandant wird per E-Mail informiert.`)
    )
      return;
    startMut(async () => {
      await updateHandoverStatusAction({ id, status: next });
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm('Anlieferung löschen?')) return;
    startMut(async () => {
      await deleteHandoverAction({ id });
      router.refresh();
    });
  }

  const active = initial.filter((h) => h.status !== 'PICKED_UP');
  const done = initial.filter((h) => h.status === 'PICKED_UP');

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <Inbox className="h-4 w-4 text-disabled" />
          Anlieferungen ({active.length})
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
          <input
            type="text"
            name="label"
            placeholder='Bezeichnung — z. B. „ESt-Unterlagen 2024"'
            className="input text-sm"
            maxLength={200}
            required
          />
          <textarea
            name="contents"
            placeholder='Inhalt (optional) — z. B. „1× Ordner Belege, Kontoauszüge Q1–Q4, Spendenquittungen"'
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
        <p className="px-6 py-6 text-sm text-disabled text-center">Keine offenen Anlieferungen.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {active.map((h) => {
            const next = NEXT_STATUS[h.status];
            return (
              <li key={h.id} className="px-6 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-primary inline-flex items-center gap-2">
                      {h.label}
                      <span className={`${STATUS_BADGE[h.status]} text-[10px]`}>
                        {STATUS_LABELS[h.status]}
                      </span>
                    </p>
                    {h.contents && (
                      <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">
                        {h.contents}
                      </p>
                    )}
                    <p className="text-[11px] text-muted mt-1 flex flex-wrap gap-x-3">
                      <span>eingegangen {fmtDateShort(new Date(h.receivedAt))}</span>
                      {h.startedAt && (
                        <span>bearbeitet seit {fmtDateShort(new Date(h.startedAt))}</span>
                      )}
                      {h.readyAt && (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <Mail className="h-3 w-3" />
                          abholbereit {fmtDateShort(new Date(h.readyAt))}
                          {h.notifiedContactEmail && (
                            <span className="text-disabled">· {h.notifiedContactEmail}</span>
                          )}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {next && (
                      <button
                        type="button"
                        onClick={() => advance(h.id, next, h.label)}
                        disabled={isMutating}
                        className="btn-secondary text-[11px] py-1 inline-flex items-center gap-1"
                        title={NEXT_LABEL[h.status]}
                      >
                        {next === 'PICKED_UP' ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <ArrowRight className="h-3 w-3" />
                        )}
                        {NEXT_LABEL[h.status]}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(h.id)}
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

      {done.length > 0 && (
        <details className="border-t border-default">
          <summary className="px-6 py-2 text-xs text-muted cursor-pointer">
            {done.length} abgeholt
          </summary>
          <ul className="divide-y divide-border-subtle">
            {done.map((h) => (
              <li key={h.id} className="px-6 py-2 text-sm text-muted flex justify-between gap-2">
                <span className="truncate">{h.label}</span>
                {h.pickedUpAt && (
                  <span className="text-xs">{fmtDateShort(new Date(h.pickedUpAt))}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
