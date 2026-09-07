'use client';

import { useState, useTransition } from 'react';
import {
  cloneReminderAction,
  setReminderAssigneesAction,
} from '../../clients/[id]/reminders/actions';
import { StaffPicker } from '../staff-picker';

export function inZweiWochen(): string {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type FormProps = {
  reminderId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  assigneeIds: string[];
  onDone: (id?: string) => void;
  onError: (error: string) => void;
};

/** REMINDER-TICKET-001: Eigenständige Aufgabe mit Verweis, keine künstliche Nachfragekette. */
export function LinkedTicketForm(props: FormProps) {
  const [due, setDue] = useState(inZweiWochen);
  const [subject, setSubject] = useState('');
  const [staffIds, setStaffIds] = useState(props.assigneeIds);
  const [text, setText] = useState('');
  const [busy, start] = useTransition();
  return (
    <form
      className="rounded-md border border-default bg-surface-raised p-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          try {
            const result = await cloneReminderAction({
              id: props.reminderId,
              alsNachfrage: false,
              alsVerknuepftesTicket: true,
              dueDate: due,
              subject: subject.trim(),
              notes: text.trim() || null,
              assigneeStaffIds: staffIds,
            });
            if (result.ok) props.onDone(result.id);
            else props.onError(result.error ?? 'Ticket konnte nicht angelegt werden.');
          } catch {
            props.onError('Ticket konnte nicht angelegt werden. Bitte erneut versuchen.');
          }
        });
      }}
    >
      <p className="text-sm font-medium text-primary">Neues verknüpftes Ticket</p>
      <fieldset disabled={busy} className="space-y-2">
        <label className="block text-xs text-muted">
          Titel
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
            maxLength={200}
            className="input text-sm w-full mt-0.5"
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="text-xs text-muted">
            Fällig
            <input
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              required
              className="input text-sm w-full mt-0.5"
            />
          </label>
          <StaffPicker
            label="Zuständig"
            options={props.staffOptions}
            value={staffIds}
            onChange={setStaffIds}
          />
        </div>
        <label className="block text-xs text-muted">
          Beschreibung
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            maxLength={2000}
            className="input text-sm w-full mt-0.5"
          />
        </label>
      </fieldset>
      <p className="text-xs text-muted">
        Die neue Aufgabe verweist auf dieses Ticket. Für eine kurze Rückfrage genügt ein Kommentar.
      </p>
      <button
        type="submit"
        disabled={busy || !subject.trim() || !due}
        className="btn-primary text-xs"
      >
        {busy ? 'Lege an …' : 'Verknüpftes Ticket anlegen'}
      </button>
    </form>
  );
}

export function AssigneeForm(props: FormProps) {
  const [staffIds, setStaffIds] = useState(props.assigneeIds);
  const [busy, start] = useTransition();
  return (
    <form
      className="rounded-md border border-default bg-surface-raised p-3 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          try {
            const result = await setReminderAssigneesAction({ id: props.reminderId, staffIds });
            if (result.ok) props.onDone();
            else props.onError(result.error ?? 'Zuweisung fehlgeschlagen.');
          } catch {
            props.onError('Zuweisung fehlgeschlagen. Bitte erneut versuchen.');
          }
        });
      }}
    >
      <fieldset disabled={busy}>
        <StaffPicker
          label="Zuständige"
          options={props.staffOptions}
          value={staffIds}
          onChange={setStaffIds}
        />
      </fieldset>
      <button
        type="submit"
        disabled={busy || staffIds.length === 0}
        className="btn-primary text-xs"
      >
        Übernehmen
      </button>
    </form>
  );
}
