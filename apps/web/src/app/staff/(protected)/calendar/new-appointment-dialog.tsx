'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { FormErrorSummary } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import { createAppointmentAction, type AppointmentActionResult } from './actions';
import {
  AppointmentFormFields,
  appointmentFieldIds,
  type AppointmentStaffOption,
} from './appointment-form-fields';

export function NewAppointmentDialog({
  staffOptions,
  currentStaffId,
  defaultStart,
}: {
  staffOptions: AppointmentStaffOption[];
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
              fieldIds={appointmentFieldIds('new-appointment')}
            />
            <AppointmentFormFields
              idPrefix="new-appointment"
              staffOptions={staffOptions}
              defaults={{ ownerStaffId: currentStaffId, startsAt: defaultStart ?? nowLocal }}
              fieldErrors={fieldErrors}
            />
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
