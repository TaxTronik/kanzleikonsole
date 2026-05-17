'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, RotateCcw, UserPlus, CalendarClock, X, Building2 } from 'lucide-react';
import {
  markPhoneNoteDoneAction,
  undoPhoneNoteDoneAction,
  forwardPhoneNoteAction,
  phoneNoteToReminderAction,
} from '@/app/staff/(protected)/phone-notes/actions';

const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export interface PhoneNoteItem {
  id: string;
  subject: string;
  callerName: string;
  callerPhone: string | null;
  body: string;
  forwardToStaff: string | null;
  doneAt: string | null;
  readAt: string | null;
  createdAt: string;
  takenByStaff: string;
  clientId: string | null;
  client?: { id: string; name: string } | null;
}

interface StaffOption { id: string; fullName: string; }

export function PhoneNotesList({
  notes,
  staffOptions,
  currentStaffId,
}: {
  notes: PhoneNoteItem[];
  staffOptions: StaffOption[];
  currentStaffId: string;
}) {
  const router = useRouter();
  const [isMutating, startMut] = useTransition();
  const [activePanel, setActivePanel] = useState<{ id: string; kind: 'forward' | 'reminder' } | null>(null);
  const staffName = new Map(staffOptions.map((s) => [s.id, s.fullName]));

  function markDone(id: string) {
    startMut(async () => {
      await markPhoneNoteDoneAction({ id });
      router.refresh();
    });
  }

  function undoDone(id: string) {
    startMut(async () => {
      await undoPhoneNoteDoneAction({ id });
      router.refresh();
    });
  }

  function forwardTo(id: string, toStaffId: string) {
    startMut(async () => {
      await forwardPhoneNoteAction({ id, toStaffId });
      setActivePanel(null);
      router.refresh();
    });
  }

  function toReminder(id: string, dueDate: string, assigneeStaffId: string) {
    startMut(async () => {
      const res = await phoneNoteToReminderAction({
        id,
        dueDate,
        assigneeStaffId: assigneeStaffId || null,
      });
      if (!res.ok) {
        alert(res.error ?? 'Konnte nicht in Wiedervorlage überführt werden.');
        return;
      }
      setActivePanel(null);
      router.refresh();
    });
  }

  const open_items = notes.filter((n) => !n.doneAt);
  const done_items = notes.filter((n) => n.doneAt);

  return (
    <div>
      {open_items.length === 0 && done_items.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-400 text-center">Keine Telefonzettel.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {open_items.map((p) => (
            <PhoneNoteRow
              key={p.id}
              note={p}
              staffName={staffName}
              currentStaffId={currentStaffId}
              isMutating={isMutating}
              activePanel={activePanel?.id === p.id ? activePanel.kind : null}
              onMarkDone={() => markDone(p.id)}
              onForwardOpen={() => setActivePanel({ id: p.id, kind: 'forward' })}
              onReminderOpen={() => setActivePanel({ id: p.id, kind: 'reminder' })}
              onClosePanel={() => setActivePanel(null)}
              onForward={(toStaffId) => forwardTo(p.id, toStaffId)}
              onToReminder={(dueDate, assigneeStaffId) => toReminder(p.id, dueDate, assigneeStaffId)}
              staffOptions={staffOptions}
            />
          ))}
        </ul>
      )}

      {done_items.length > 0 && (
        <details className="border-t border-gray-200 dark:border-gray-800">
          <summary className="px-6 py-2 text-xs text-gray-500 cursor-pointer">
            {done_items.length} erledigt
          </summary>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {done_items.map((p) => (
              <li key={p.id} className="px-6 py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-through truncate">{p.subject}</p>
                  <p className="text-[11px] text-gray-400">
                    {p.callerName} · erledigt {p.doneAt ? dateTimeFmt.format(new Date(p.doneAt)) : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => undoDone(p.id)}
                  disabled={isMutating}
                  className="text-gray-400 hover:text-gray-700 p-1 shrink-0"
                  title="Auf offen zurücksetzen"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PhoneNoteRow({
  note,
  staffName,
  currentStaffId,
  isMutating,
  activePanel,
  onMarkDone,
  onForwardOpen,
  onReminderOpen,
  onClosePanel,
  onForward,
  onToReminder,
  staffOptions,
}: {
  note: PhoneNoteItem;
  staffName: Map<string, string>;
  currentStaffId: string;
  isMutating: boolean;
  activePanel: 'forward' | 'reminder' | null;
  onMarkDone: () => void;
  onForwardOpen: () => void;
  onReminderOpen: () => void;
  onClosePanel: () => void;
  onForward: (toStaffId: string) => void;
  onToReminder: (dueDate: string, assigneeStaffId: string) => void;
  staffOptions: StaffOption[];
}) {
  const forwarded_to = note.forwardToStaff ? staffName.get(note.forwardToStaff) : null;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDue = tomorrow.toISOString().slice(0, 10);

  return (
    <li className="px-6 py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onMarkDone}
          disabled={isMutating}
          className="mt-0.5 w-5 h-5 rounded border-2 border-gray-300 hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:border-gray-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20 shrink-0"
          title="Als erledigt markieren"
        >
          <Check className="h-3 w-3" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{note.subject}</p>
            {!note.readAt && <span className="badge-yellow text-[10px]">ungelesen</span>}
          </div>
          <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2">
            <span>
              {note.callerName}
              {note.callerPhone && ` · ${note.callerPhone}`}
            </span>
            {note.client && (
              <Link
                href={`/staff/clients/${note.client.id}`}
                className="inline-flex items-center gap-1 hover:text-brand-700"
              >
                <Building2 className="h-3 w-3" />
                {note.client.name}
              </Link>
            )}
            {forwarded_to && <span>· an {forwarded_to}</span>}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap line-clamp-3">
            {note.body}
          </p>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {dateTimeFmt.format(new Date(note.createdAt))}
          </p>

          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={onForwardOpen}
              disabled={isMutating}
              className="text-[11px] text-gray-500 hover:text-brand-700 inline-flex items-center gap-1"
            >
              <UserPlus className="h-3 w-3" />
              Übertragen
            </button>
            {note.clientId && (
              <>
                <span className="text-gray-300">·</span>
                <button
                  type="button"
                  onClick={onReminderOpen}
                  disabled={isMutating}
                  className="text-[11px] text-gray-500 hover:text-brand-700 inline-flex items-center gap-1"
                >
                  <CalendarClock className="h-3 w-3" />
                  Wiedervorlage
                </button>
              </>
            )}
          </div>

          {activePanel === 'forward' && (
            <div className="mt-2 p-2 rounded bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 flex items-center gap-2">
              <select
                className="input text-xs flex-1"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) onForward(e.target.value);
                }}
                disabled={isMutating}
              >
                <option value="">— Mitarbeiter wählen —</option>
                {staffOptions
                  .filter((s) => s.id !== note.forwardToStaff)
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.fullName}</option>
                  ))}
              </select>
              <button
                type="button"
                onClick={onClosePanel}
                className="text-gray-400 hover:text-gray-700 p-1"
                title="Abbrechen"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {activePanel === 'reminder' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                onToReminder(String(fd.get('dueDate') ?? ''), String(fd.get('assignee') ?? ''));
              }}
              className="mt-2 p-2 rounded bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 grid grid-cols-3 gap-2"
            >
              <input
                type="date"
                name="dueDate"
                defaultValue={defaultDue}
                min={new Date().toISOString().slice(0, 10)}
                className="input text-xs"
                required
              />
              <select
                name="assignee"
                defaultValue={note.forwardToStaff ?? currentStaffId}
                className="input text-xs"
              >
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <button type="submit" disabled={isMutating} className="btn-primary text-[11px] py-1 flex-1">
                  Anlegen
                </button>
                <button
                  type="button"
                  onClick={onClosePanel}
                  className="text-gray-400 hover:text-gray-700 p-1"
                  title="Abbrechen"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </li>
  );
}
