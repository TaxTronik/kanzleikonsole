'use client';

// =============================================================================
// Termin bearbeiten oder absagen (Review-Befund C1)
//
// Die Terminpille im Kanzleikalender öffnet diesen Dialog. Gespeichert wird über
// updateAppointmentAction mit denselben Feldern und Grenzen wie bei der Anlage;
// „Termin absagen" setzt über cancelAppointmentAction den Status CANCELLED
// (auditiert), gelöscht wird nicht mehr.
//
// Welle 15 (Entscheidung „Checkbox im Dialog“): Bearbeiten und Absagen bieten je
// „Mandant per E-Mail informieren“ an — vorausgewählt, wenn der Termin einen
// erreichbaren Mandantenkontakt hat (Regel der Entscheidungsmail, siehe
// server/appointments/client-mail.ts), sonst deaktiviert mit Grund. Ohne
// Häkchen geht keine Mail hinaus.
// =============================================================================

import Link from 'next/link';
import { useActionState, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { FieldError, FormErrorSummary } from '@/components/form-errors';
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
import type { AppointmentClientMailOption } from '@/server/appointments/client-mail';

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
  /** Welle 15: Empfänger der Mandanten-Mail oder der Grund, warum es keine gibt. */
  clientMail: AppointmentClientMailOption;
}

export const APPOINTMENT_MAIL_LABEL = 'Mandant per E-Mail informieren';
export const APPOINTMENT_MAIL_OPT_IN_HINT = 'Ohne Häkchen wird der Mandant nicht benachrichtigt.';
export const APPOINTMENT_CHANGE_MAIL_HINT =
  'Die Mail nennt Titel, Zeit und Ort, keine Notizen; sie geht nur hinaus, wenn sich davon etwas ändert.';
export const APPOINTMENT_CANCEL_MAIL_HINT =
  'Die Mail nennt Titel und Zeit des abgesagten Termins, keine Notizen.';
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

function recipientList(option: AppointmentClientMailOption): string {
  return option.recipients.map((r) => `${r.fullName} (${r.email})`).join(', ');
}

/**
 * Checkbox „Mandant per E-Mail informieren“: vorausgewählt mit Empfängern,
 * sonst deaktiviert mit kurzem Grund. Im Bearbeiten-Formular sendet sie das
 * Feld `notifyClient`; für die Absage (eigene Aktion, kein Formularfeld) steuern
 * `checked`/`onChange` sie ohne Feldnamen, damit sie das Speichern nicht beeinflusst.
 */
export function AppointmentClientMailCheckbox({
  id,
  option,
  hint,
  errors,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  option: AppointmentClientMailOption;
  hint: string;
  errors?: readonly string[];
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const available = option.recipients.length > 0;
  const controlled = onChange
    ? { checked: available && Boolean(checked), onChange: () => onChange(!checked) }
    : { name: 'notifyClient', value: 'on', defaultChecked: available };
  return (
    <div className="rounded-md border border-default p-3 text-sm" data-client-mail={id}>
      <label htmlFor={id} className="flex items-start gap-2 text-secondary">
        <input
          id={id}
          type="checkbox"
          disabled={!available || disabled}
          aria-describedby={`${id}-hint`}
          {...controlled}
        />
        <span className="font-medium text-primary">{APPOINTMENT_MAIL_LABEL}</span>
      </label>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {available
          ? `An: ${recipientList(option)}. ${hint} ${APPOINTMENT_MAIL_OPT_IN_HINT}`
          : `Nicht möglich: ${option.unavailableReason ?? 'kein erreichbarer Empfänger.'}`}
      </p>
      <FieldError name="notifyClient" errors={errors} prefix={id} />
    </div>
  );
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
  const [notifyOnCancel, setNotifyOnCancel] = useState(
    appointment.clientMail.recipients.length > 0,
  );
  const busy = isSaving || isCancelling;
  const fieldErrors = state?.fieldErrors;

  function cancelAppointment() {
    setCancelError(null);
    startCancel(async () => {
      const result = await cancelAppointmentAction({
        id: appointment.id,
        notifyClient: notifyOnCancel && appointment.clientMail.recipients.length > 0,
      });
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setCancelError(
          result.fieldErrors?.['notifyClient']?.[0] ??
            result.error ??
            'Der Termin konnte nicht abgesagt werden.',
        );
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
        <AppointmentClientMailCheckbox
          id={`${ID_PREFIX}-notify`}
          option={appointment.clientMail}
          hint={APPOINTMENT_CHANGE_MAIL_HINT}
          errors={fieldErrors?.['notifyClient']}
        />
        {appointment.fromRequest ? (
          <p className="text-xs text-muted">{APPOINTMENT_FROM_REQUEST_HINT}</p>
        ) : null}
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
              sich nicht rückgängig machen.
            </p>
            <AppointmentClientMailCheckbox
              id={`${ID_PREFIX}-cancel-notify`}
              option={appointment.clientMail}
              hint={APPOINTMENT_CANCEL_MAIL_HINT}
              checked={notifyOnCancel}
              onChange={setNotifyOnCancel}
              disabled={busy}
            />
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
