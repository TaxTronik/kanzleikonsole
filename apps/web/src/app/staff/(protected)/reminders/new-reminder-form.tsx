'use client';

import { useActionState, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { REMINDER_PRIORITIES, PRIORITY_LABEL } from '@/lib/reminder-priority';
import { createReminderAction } from '../clients/[id]/reminders/actions';
import type { ActionResult } from '@/server/actions/staff-action';
import { StaffPicker } from './[id]/reminder-detail-view';

/**
 * Neue Wiedervorlage — mandantenbezogen ODER intern, mit mehreren Zuständigen.
 *
 * Der Mandant ist eine Auswahl über die zugänglichen Mandate (der Server prüft
 * sie erneut). „Intern" heisst: keine Mandantenakte, nur eine Kanzleiaufgabe.
 */
export function NewReminderForm({
  clients,
  staffOptions,
}: {
  clients: Array<{ id: string; name: string }>;
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createReminderAction,
    null,
  );
  const [open, setOpen] = useState(false);
  const [staffIds, setStaffIds] = useState<string[]>([]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary text-sm">
        <Plus className="h-4 w-4" /> Neue Wiedervorlage
      </button>
    );
  }

  return (
    <form action={formAction} className="card p-4 space-y-3">
      {/* Mehrfachauswahl kommt über wiederholte Felder — getAll() liest sie. */}
      {staffIds.map((id) => (
        <input key={id} type="hidden" name="assigneeStaffIds" value={id} />
      ))}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-primary">Neue Wiedervorlage</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-disabled hover:text-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="text-muted">Mandant</span>
          <select name="clientId" defaultValue="intern" className="input text-sm w-full mt-0.5">
            <option value="intern">— intern (ohne Mandant) —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="text-muted">Fällig</span>
          <input
            type="date"
            name="dueDate"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
            className="input text-sm w-full mt-0.5"
          />
        </label>
      </div>

      <label className="block text-xs">
        <span className="text-muted">Stichwort</span>
        <input
          type="text"
          name="subject"
          required
          maxLength={200}
          placeholder='z. B. „Belege 2025 nachfordern"'
          className="input text-sm w-full mt-0.5"
        />
      </label>

      <label className="block text-xs">
        <span className="text-muted">Auftrag / Notiz</span>
        <textarea name="notes" rows={2} maxLength={2000} className="input text-sm w-full mt-0.5" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="text-muted">Priorität</span>
          <select name="priority" defaultValue="NORMAL" className="input text-sm w-full mt-0.5">
            {REMINDER_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <StaffPicker
          label="Zuständig (mehrere möglich)"
          options={staffOptions}
          value={staffIds}
          onChange={setStaffIds}
        />
      </div>
      <p className="text-[11px] text-disabled">
        Ohne Auswahl bist du selbst zuständig. Mehrere Personen teilen sich EINE Aufgabe — wer sie
        abhakt, erledigt sie für alle.
      </p>

      {state && !state.ok && <p className="text-xs text-red-700">{state.error}</p>}
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
