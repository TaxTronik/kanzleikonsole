'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import {
  FieldError,
  FormErrorSummary,
  fieldErrorProps,
  type FieldErrors,
} from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import { createAppointmentAction, type AppointmentActionResult } from './actions';

interface StaffOption {
  id: string;
  fullName: string;
}
interface ClientOption {
  id: string;
  name: string;
}

function AppointmentFieldError({ name, fieldErrors }: { name: string; fieldErrors?: FieldErrors }) {
  return <FieldError name={name} errors={fieldErrors?.[name]} />;
}

export function NewAppointmentDialog({
  staffOptions,
  clientOptions,
  currentStaffId,
  defaultStart,
}: {
  staffOptions: StaffOption[];
  clientOptions: ClientOption[];
  currentStaffId: string;
  defaultStart?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<AppointmentActionResult | null, FormData>(
    async (previous, data) => {
      const result = await createAppointmentAction(previous, data);
      if (result.ok) {
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    null,
  );
  const fieldErrors = state?.fieldErrors;
  const actionError = state?.error;

  const nowLocal = (() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  })();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-primary text-xs inline-flex items-center gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        Neuer Termin
      </button>

      {open && (
        <Modal
          title="Neuer Termin"
          onClose={() => setOpen(false)}
          panelClassName="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          showCloseButton={false}
          closeDisabled={isPending}
        >
          <div className="px-5 py-3 border-b border-default flex items-center justify-between">
            <h2 className="text-sm font-medium text-primary">Neuer Termin</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-disabled hover:text-primary"
              aria-label="Schließen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <form action={formAction} className="p-5 space-y-3" aria-busy={isPending}>
            <FormErrorSummary
              error={actionError}
              fieldErrors={fieldErrors}
              fieldIds={{
                title: 'new-appointment-title',
                kind: 'new-appointment-kind',
                ownerStaffId: 'new-appointment-owner',
                clientId: 'new-appointment-client',
                startsAt: 'new-appointment-start',
                endsAt: 'new-appointment-end',
                location: 'new-appointment-location',
                notes: 'new-appointment-notes',
              }}
            />
            <div>
              <label className="label" htmlFor="new-appointment-title">
                Titel
              </label>
              <input
                id="new-appointment-title"
                type="text"
                name="title"
                required
                maxLength={200}
                className="input"
                placeholder='z. B. „Bilanzbesprechung Müller GmbH"'
                {...fieldErrorProps('title', fieldErrors)}
              />
              <AppointmentFieldError name="title" fieldErrors={fieldErrors} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="new-appointment-kind">
                  Art
                </label>
                <select
                  id="new-appointment-kind"
                  name="kind"
                  defaultValue="CLIENT_MEETING"
                  className="input"
                  {...fieldErrorProps('kind', fieldErrors)}
                >
                  <option value="CLIENT_MEETING">Mandantentermin</option>
                  <option value="INTERNAL">Intern</option>
                  <option value="PRIVATE">Privat / blocken</option>
                </select>
                <AppointmentFieldError name="kind" fieldErrors={fieldErrors} />
              </div>
              <div>
                <label className="label" htmlFor="new-appointment-owner">
                  Für (Owner)
                </label>
                <select
                  id="new-appointment-owner"
                  name="ownerStaffId"
                  defaultValue={currentStaffId}
                  required
                  className="input"
                  {...fieldErrorProps('ownerStaffId', fieldErrors)}
                >
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName}
                    </option>
                  ))}
                </select>
                <AppointmentFieldError name="ownerStaffId" fieldErrors={fieldErrors} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="new-appointment-client">
                Mandant (optional)
              </label>
              <select
                id="new-appointment-client"
                name="clientId"
                defaultValue=""
                className="input"
                {...fieldErrorProps('clientId', fieldErrors)}
              >
                <option value="">— ohne Mandantenbezug —</option>
                {clientOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <AppointmentFieldError name="clientId" fieldErrors={fieldErrors} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="new-appointment-start">
                  Start
                </label>
                <input
                  id="new-appointment-start"
                  type="datetime-local"
                  name="startsAt"
                  defaultValue={defaultStart ?? nowLocal}
                  required
                  className="input"
                  {...fieldErrorProps('startsAt', fieldErrors)}
                />
                <AppointmentFieldError name="startsAt" fieldErrors={fieldErrors} />
              </div>
              <div>
                <label className="label" htmlFor="new-appointment-end">
                  Ende
                </label>
                <input
                  id="new-appointment-end"
                  type="datetime-local"
                  name="endsAt"
                  required
                  className="input"
                  {...fieldErrorProps('endsAt', fieldErrors)}
                />
                <AppointmentFieldError name="endsAt" fieldErrors={fieldErrors} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="new-appointment-location">
                Ort (optional)
              </label>
              <input
                id="new-appointment-location"
                type="text"
                name="location"
                maxLength={200}
                className="input"
                placeholder="Büro, Video-Call, Telefon, …"
                {...fieldErrorProps('location', fieldErrors)}
              />
              <AppointmentFieldError name="location" fieldErrors={fieldErrors} />
            </div>
            <div>
              <label className="label" htmlFor="new-appointment-notes">
                Notizen (optional)
              </label>
              <textarea
                id="new-appointment-notes"
                name="notes"
                rows={3}
                maxLength={4000}
                className="input"
                {...fieldErrorProps('notes', fieldErrors)}
              />
              <AppointmentFieldError name="notes" fieldErrors={fieldErrors} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-secondary text-sm"
              >
                Abbrechen
              </button>
              <button type="submit" disabled={isPending} className="btn-primary text-sm">
                {isPending ? 'Speichert…' : 'Anlegen'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
