'use client';

import { useActionState } from 'react';
import { Inbox, Mail } from 'lucide-react';

import { fmtDateShort } from '@/lib/fmt';
import type { ActionResult } from '@/server/actions/staff-action';

import { ClientStatusFlowCard, type ClientStatusFlowDefinition } from '../status-flow-card';
import { createHandoverAction, deleteHandoverAction, updateHandoverStatusAction } from './actions';

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

const HANDOVER_FLOW = {
  terminalStatus: 'PICKED_UP',
  labels: {
    RECEIVED: 'Eingegangen',
    IN_PROGRESS: 'In Bearbeitung',
    READY: 'Abholbereit',
    PICKED_UP: 'Abgeholt',
  },
  badgeClasses: {
    RECEIVED: 'badge-gray',
    IN_PROGRESS: 'badge-yellow',
    READY: 'badge-green',
    PICKED_UP: 'badge-gray',
  },
  next: {
    RECEIVED: 'IN_PROGRESS',
    IN_PROGRESS: 'READY',
    READY: 'PICKED_UP',
    PICKED_UP: null,
  },
  transitionLabels: {
    RECEIVED: 'Bearbeiten',
    IN_PROGRESS: 'Abholbereit melden',
    READY: 'Abgeholt',
    PICKED_UP: '',
  },
} satisfies ClientStatusFlowDefinition<HandoverStatus>;

export function HandoversBlock({ clientId, initial }: { clientId: string; initial: Handover[] }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createHandoverAction,
    null,
  );

  return (
    <ClientStatusFlowCard<HandoverStatus, Handover>
      title="Anlieferungen"
      icon={Inbox}
      items={initial}
      flow={HANDOVER_FLOW}
      emptyText="Keine offenen Anlieferungen."
      updateStatus={(id, status) => updateHandoverStatusAction({ id, status })}
      deleteItem={(id) => deleteHandoverAction({ id })}
      confirmDelete={() => confirm('Anlieferung löschen?')}
      confirmTransition={(handover, next) =>
        next !== 'READY' ||
        confirm(
          `„${handover.label}" als abholbereit melden? Der Mandant wird per E-Mail informiert.`,
        )
      }
      renderCreateForm={(close) => (
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
      renderMeta={(handover) => (
        <p className="text-[11px] text-muted mt-1 flex flex-wrap gap-x-3">
          <span>eingegangen {fmtDateShort(new Date(handover.receivedAt))}</span>
          {handover.startedAt && (
            <span>bearbeitet seit {fmtDateShort(new Date(handover.startedAt))}</span>
          )}
          {handover.readyAt && (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <Mail className="h-3 w-3" />
              abholbereit {fmtDateShort(new Date(handover.readyAt))}
              {handover.notifiedContactEmail && (
                <span className="text-disabled">· {handover.notifiedContactEmail}</span>
              )}
            </span>
          )}
        </p>
      )}
      completedSummary={(count) => `${count} abgeholt`}
      renderCompletedMeta={(handover) =>
        handover.pickedUpAt ? (
          <span className="text-xs">{fmtDateShort(new Date(handover.pickedUpAt))}</span>
        ) : null
      }
    />
  );
}
