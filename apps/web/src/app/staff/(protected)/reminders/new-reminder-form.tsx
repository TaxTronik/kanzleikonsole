'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { REMINDER_PRIORITIES, PRIORITY_LABEL } from '@/lib/reminder-priority';
import { createReminderAction } from '../clients/[id]/reminders/actions';
import type { ActionResult } from '@/server/actions/staff-action';
import { StaffPicker } from './staff-picker';
import { ClientCombobox } from '@/components/ui/client-combobox';
import { FieldError, FormErrorSummary, fieldErrorProps } from '@/components/form-errors';

/** Präfix der Fehler-IDs, eindeutig neben weiteren Formularen der Seite. */
const PREFIX = 'new-reminder';

/**
 * Neue Wiedervorlage — mandantenbezogen ODER intern, mit mehreren Zuständigen.
 *
 * Der Mandant wird per Serversuche über die zugänglichen Mandate gewählt (der
 * Server prüft ihn erneut). Ohne Auswahl ist es eine interne Kanzleiaufgabe.
 */
export function NewReminderForm({
  staffOptions,
}: {
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    async (previous, data) => {
      const result = await createReminderAction(previous, data);
      if (result.ok) {
        setOpen(false);
        setStaffIds([]);
        router.refresh();
      }
      return result;
    },
    null,
  );

  const fieldErrors = state?.fieldErrors;
  const errorProps = (name: string) => fieldErrorProps(name, fieldErrors, { prefix: PREFIX });
  const fieldError = (name: string) => (
    <FieldError name={name} errors={fieldErrors?.[name]} prefix={PREFIX} />
  );

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary text-sm">
        <Plus className="h-4 w-4" /> Neues Ticket
      </button>
    );
  }

  return (
    <form action={formAction} className="card p-4 space-y-3">
      <FormErrorSummary
        error={state?.ok ? undefined : state?.error}
        fieldErrors={fieldErrors}
        fieldIds={{
          clientId: 'new-reminder-client',
          dueDate: 'new-reminder-due',
          subject: 'new-reminder-subject',
          notes: 'new-reminder-notes',
          priority: 'new-reminder-priority',
        }}
      />
      {/* Mehrfachauswahl kommt über wiederholte Felder — getAll() liest sie. */}
      {staffIds.map((id) => (
        <input key={id} type="hidden" name="assigneeStaffIds" value={id} />
      ))}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-primary">Neues Ticket</p>
        <button
          type="button"
          aria-label="Neues Ticket schließen"
          disabled={isPending}
          onClick={() => setOpen(false)}
          className="text-disabled hover:text-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="text-xs min-w-0">
          <label className="text-muted" htmlFor="new-reminder-client">
            Mandant
          </label>
          {/* Leer = interne Aufgabe; die Action wertet ein leeres Feld als „intern". */}
          <div className="mt-0.5">
            <ClientCombobox
              id="new-reminder-client"
              name="clientId"
              placeholder="Intern (ohne Mandant) — suchen"
              inputClassName="input text-sm w-full pr-9"
              {...errorProps('clientId')}
            />
          </div>
          {fieldError('clientId')}
        </div>
        <div className="text-xs">
          <label className="block">
            <span className="text-muted">Fällig</span>
            <input
              id="new-reminder-due"
              type="date"
              name="dueDate"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
              className="input text-sm w-full mt-0.5"
              {...errorProps('dueDate')}
            />
          </label>
          {fieldError('dueDate')}
        </div>
      </div>

      <div className="text-xs">
        <label className="block">
          <span className="text-muted">Titel</span>
          <input
            id="new-reminder-subject"
            type="text"
            name="subject"
            required
            maxLength={200}
            placeholder='z. B. „Belege 2025 nachfordern"'
            className="input text-sm w-full mt-0.5"
            {...errorProps('subject')}
          />
        </label>
        {fieldError('subject')}
      </div>

      <div className="text-xs">
        <label className="block">
          <span className="text-muted">Beschreibung</span>
          <textarea
            id="new-reminder-notes"
            name="notes"
            rows={2}
            maxLength={2000}
            className="input text-sm w-full mt-0.5"
            {...errorProps('notes')}
          />
          <span className="text-muted">Mit #123 auf ein zugängliches Ticket verweisen.</span>
        </label>
        {fieldError('notes')}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="text-xs">
          <label className="block">
            <span className="text-muted">Priorität</span>
            <select
              id="new-reminder-priority"
              name="priority"
              defaultValue="NORMAL"
              className="input text-sm w-full mt-0.5"
              {...errorProps('priority')}
            >
              {REMINDER_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          {fieldError('priority')}
        </div>
        <div>
          <StaffPicker
            label="Zuständig (mehrere möglich)"
            options={staffOptions}
            value={staffIds}
            onChange={setStaffIds}
          />
          {fieldError('assigneeStaffIds')}
        </div>
      </div>
      <p className="text-[11px] text-disabled">
        Ohne Auswahl bist du selbst zuständig. Mehrere Personen teilen sich EINE Aufgabe — wer sie
        abhakt, erledigt sie für alle.
      </p>

      <div className="flex items-center gap-2">
        <button type="submit" disabled={isPending} className="btn-primary text-xs">
          {isPending ? 'Lege an …' : 'Anlegen'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="btn-secondary text-xs"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}
