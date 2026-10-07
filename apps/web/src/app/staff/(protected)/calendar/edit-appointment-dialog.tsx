'use client';

// =============================================================================
// Termin bearbeiten oder absagen (Review-Befund C1)
//
// Die Terminpille im Kanzleikalender öffnet diesen Dialog. Gespeichert wird über
// updateAppointmentAction mit denselben Feldern und Grenzen wie bei der Anlage;
// „Termin absagen" setzt über cancelAppointmentAction den Status CANCELLED
// (auditiert), gelöscht wird nicht mehr. Ob der Mandant bei einer Änderung oder
// Absage eine Mail erhält, ist nicht entschieden: Der Dialog sagt ausdrücklich,
// dass keine automatische Benachrichtigung erfolgt.
// =============================================================================

import Link from 'next/link';
import { useActionState, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { FormErrorSummary } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import {
  cancelAppointmentAction,
  updateAppointmentAction,
  type AppointmentActionResult,
} from './actions';
import {
  AppointmentFormFields,
  appointmentFieldIds,
  type AppointmentFormKind,
  type AppointmentFormStatus,
  type AppointmentStaffOption,
} from './appointment-form-fields';

export interface EditableAppointment {
  id: string;
  title: string;
  kind: AppointmentFormKind;
  status: AppointmentFormStatus;
  ownerStaffId: string;
  ownerName: string;
  client: { id: string; name: string } | null;
  /** Berlin-Wanduhrzeit `YYYY-MM-DDTHH:MM`. */
  startsAt: string;
  endsAt: string;
  location: string | null;
  notes: string | null;
  /** Aus einer Portal-Terminanfrage angenommen (mit Terminbestätigung). */
  fromRequest: boolean;
}

export const APPOINTMENT_NOT_NOTIFIED_HINT =
  'Der Mandant wird über Änderungen und Absagen nicht automatisch benachrichtigt.';
export const APPOINTMENT_FROM_REQUEST_HINT =
  'Der Termin stammt aus einer Terminanfrage im Portal; eine noch nicht zugestellte Terminbestätigung wird nach einer Verschiebung oder Absage nicht mehr versendet.';

const ID_PREFIX = 'edit-appointment';

/** Bearbeiterauswahl; ein inzwischen deaktivierter Owner bleibt wählbar statt still zu wechseln. */
export function ownerOptionsFor(
  appointment: Pick<EditableAppointment, 'ownerStaffId' | 'ownerName'>,
  staffOptions: readonly AppointmentStaffOption[],
): readonly AppointmentStaffOption[] {
  return staffOptions.some((option) => option.id === appointment.ownerStaffId)
    ? staffOptions
    : [
        { id: appointment.ownerStaffId, fullName: `${appointment.ownerName} (nicht mehr aktiv)` },
        ...staffOptions,
      ];
}

export function EditAppointmentDialog({
  appointment,
  staffOptions,
  label,
  children,
}: {
  appointment: EditableAppointment;
  staffOptions: readonly AppointmentStaffOption[];
  /** Tooltip der Pille. */
  label: string;
  /** Pilleninhalt, serverseitig in Berlin-Zeit formatiert. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cal-pill cal-pill-appointment w-full text-left"
        title={label}
        aria-haspopup="dialog"
        data-appointment-edit={appointment.id}
      >
        {children}
      </button>
      {open && (
        <AppointmentEditModal
          appointment={appointment}
          staffOptions={staffOptions}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function AppointmentEditModal({
  appointment,
  staffOptions,
  onClose,
}: {
  appointment: EditableAppointment;
  staffOptions: readonly AppointmentStaffOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, formAction, isSaving] = useActionState<AppointmentActionResult | null, FormData>(
    async (previous, data) => {
      const result = await updateAppointmentAction(previous, data);
      if (result.ok) {
        onClose();
        router.refresh();
      }
      return result;
    },
    null,
  );
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isCancelling, startCancel] = useTransition();
  const busy = isSaving || isCancelling;
  const fieldErrors = state?.fieldErrors;

  function cancelAppointment() {
    setCancelError(null);
    startCancel(async () => {
      const result = await cancelAppointmentAction({ id: appointment.id });
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setCancelError(result.error ?? 'Der Termin konnte nicht abgesagt werden.');
      }
    });
  }

  return (
    <Modal
      title="Termin bearbeiten"
      onClose={onClose}
      panelClassName="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      showCloseButton={false}
      closeDisabled={busy}
    >
      <div className="px-5 py-3 border-b border-default flex items-center justify-between">
        <h2 className="text-sm font-medium text-primary">Termin bearbeiten</h2>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-disabled hover:text-primary"
          aria-label="Schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <form action={formAction} className="p-5 space-y-3" aria-busy={busy}>
        <FormErrorSummary
          error={state?.error}
          fieldErrors={fieldErrors}
          fieldIds={appointmentFieldIds(ID_PREFIX)}
        />
        <input type="hidden" name="id" value={appointment.id} />
        <AppointmentFormFields
          idPrefix={ID_PREFIX}
          staffOptions={ownerOptionsFor(appointment, staffOptions)}
          defaults={{
            title: appointment.title,
            kind: appointment.kind,
            status: appointment.status,
            ownerStaffId: appointment.ownerStaffId,
            client: appointment.client,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            location: appointment.location,
            notes: appointment.notes,
          }}
          fieldErrors={fieldErrors}
        />
        <p className="text-xs text-muted">
          {APPOINTMENT_NOT_NOTIFIED_HINT}
          {appointment.fromRequest ? ` ${APPOINTMENT_FROM_REQUEST_HINT}` : null}
        </p>
        {appointment.client ? (
          <p className="text-xs">
            <Link
              href={`/staff/clients/${appointment.client.id}`}
              className="text-brand-700 hover:underline"
            >
              Mandantenakte öffnen
            </Link>
          </p>
        ) : null}
        <details className="rounded-md border border-default p-3 text-sm">
          <summary className="cursor-pointer font-medium text-red-700 dark:text-red-300">
            Termin absagen …
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted">
              Der Termin bleibt im Kalender als abgesagt sichtbar und verschwindet aus den
              Übersichten, dem Portal und dem Kalender-Abonnement des Mandanten. Eine Absage lässt
              sich nicht rückgängig machen. {APPOINTMENT_NOT_NOTIFIED_HINT}
            </p>
            {cancelError ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                {cancelError}
              </p>
            ) : null}
            <button
              type="button"
              onClick={cancelAppointment}
              disabled={busy}
              className="btn-danger-outline text-sm"
              data-appointment-cancel={appointment.id}
            >
              {isCancelling ? 'Wird abgesagt …' : 'Absage bestätigen'}
            </button>
          </div>
        </details>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary text-sm">
            Abbrechen
          </button>
          <button type="submit" disabled={busy} className="btn-primary text-sm">
            {isSaving ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
