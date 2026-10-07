// =============================================================================
// Gemeinsame Terminfelder für „Neuer Termin" und „Termin bearbeiten"
// (Review-Befund C1)
//
// Beide Dialoge senden dieselben Feldnamen mit denselben Eingabegrenzen;
// serverseitig validieren Anlage und Änderung mit demselben Feldschema. Abgesagt
// wird nicht über das Statusfeld, sondern über die eigene Absage-Aktion.
// =============================================================================

import { FieldError, fieldErrorProps, type FieldErrors } from '@/components/form-errors';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';

export interface AppointmentStaffOption {
  id: string;
  fullName: string;
}

export type AppointmentFormKind = 'CLIENT_MEETING' | 'INTERNAL' | 'PRIVATE';

/** Im Formular wählbare Status; CANCELLED setzt nur „Termin absagen". */
export const APPOINTMENT_STATUS_OPTIONS = [
  { value: 'PLANNED', label: 'Geplant' },
  { value: 'CONFIRMED', label: 'Bestätigt' },
  { value: 'DONE', label: 'Erledigt' },
] as const;

export type AppointmentFormStatus = (typeof APPOINTMENT_STATUS_OPTIONS)[number]['value'];

export interface AppointmentFormDefaults {
  title?: string;
  kind?: AppointmentFormKind;
  /** Nur beim Bearbeiten gesetzt; blendet die Statusauswahl ein. */
  status?: AppointmentFormStatus;
  ownerStaffId: string;
  client?: ClientComboboxValue | null;
  /** Berlin-Wanduhrzeit `YYYY-MM-DDTHH:MM` (datetime-local). */
  startsAt?: string;
  endsAt?: string;
  location?: string | null;
  notes?: string | null;
}

const FIELD_ID_SUFFIX = {
  title: 'title',
  kind: 'kind',
  status: 'status',
  ownerStaffId: 'owner',
  clientId: 'client',
  startsAt: 'start',
  endsAt: 'end',
  location: 'location',
  notes: 'notes',
} as const;

type AppointmentField = keyof typeof FIELD_ID_SUFFIX;

/** Element-IDs der Felder je Dialog (Label, Fehlerzusammenfassung). */
export function appointmentFieldIds(prefix: string): Record<AppointmentField, string> {
  return Object.fromEntries(
    Object.entries(FIELD_ID_SUFFIX).map(([field, suffix]) => [field, `${prefix}-${suffix}`]),
  ) as Record<AppointmentField, string>;
}

function AppointmentFieldError({ name, fieldErrors }: { name: string; fieldErrors?: FieldErrors }) {
  return <FieldError name={name} errors={fieldErrors?.[name]} />;
}

export function AppointmentFormFields({
  idPrefix,
  staffOptions,
  defaults,
  fieldErrors,
}: {
  idPrefix: string;
  staffOptions: readonly AppointmentStaffOption[];
  defaults: AppointmentFormDefaults;
  fieldErrors?: FieldErrors;
}) {
  const ids = appointmentFieldIds(idPrefix);
  return (
    <>
      <div>
        <label className="label" htmlFor={ids.title}>
          Titel
        </label>
        <input
          id={ids.title}
          type="text"
          name="title"
          required
          maxLength={200}
          defaultValue={defaults.title}
          className="input"
          placeholder='z. B. „Bilanzbesprechung Müller GmbH"'
          {...fieldErrorProps('title', fieldErrors)}
        />
        <AppointmentFieldError name="title" fieldErrors={fieldErrors} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={ids.kind}>
            Art
          </label>
          <select
            id={ids.kind}
            name="kind"
            defaultValue={defaults.kind ?? 'CLIENT_MEETING'}
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
          <label className="label" htmlFor={ids.ownerStaffId}>
            Für (Owner)
          </label>
          <select
            id={ids.ownerStaffId}
            name="ownerStaffId"
            defaultValue={defaults.ownerStaffId}
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
      {defaults.status !== undefined && (
        <div>
          <label className="label" htmlFor={ids.status}>
            Status
          </label>
          <select
            id={ids.status}
            name="status"
            defaultValue={defaults.status}
            className="input"
            {...fieldErrorProps('status', fieldErrors)}
          >
            {APPOINTMENT_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <AppointmentFieldError name="status" fieldErrors={fieldErrors} />
        </div>
      )}
      <div>
        <label className="label" htmlFor={ids.clientId}>
          Mandant (optional)
        </label>
        {/* Serversuche statt der ersten 500 Mandanten; leer = ohne Mandantenbezug. */}
        <ClientCombobox
          id={ids.clientId}
          name="clientId"
          filters={['active']}
          defaultValue={defaults.client ?? null}
          placeholder="Ohne Mandantenbezug — Name, DATEV- oder Addison-Nr. suchen"
          {...fieldErrorProps('clientId', fieldErrors)}
        />
        <AppointmentFieldError name="clientId" fieldErrors={fieldErrors} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={ids.startsAt}>
            Start
          </label>
          <input
            id={ids.startsAt}
            type="datetime-local"
            name="startsAt"
            defaultValue={defaults.startsAt}
            required
            className="input"
            {...fieldErrorProps('startsAt', fieldErrors)}
          />
          <AppointmentFieldError name="startsAt" fieldErrors={fieldErrors} />
        </div>
        <div>
          <label className="label" htmlFor={ids.endsAt}>
            Ende
          </label>
          <input
            id={ids.endsAt}
            type="datetime-local"
            name="endsAt"
            defaultValue={defaults.endsAt}
            required
            className="input"
            {...fieldErrorProps('endsAt', fieldErrors)}
          />
          <AppointmentFieldError name="endsAt" fieldErrors={fieldErrors} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={ids.location}>
          Ort (optional)
        </label>
        <input
          id={ids.location}
          type="text"
          name="location"
          maxLength={200}
          defaultValue={defaults.location ?? undefined}
          className="input"
          placeholder="Büro, Video-Call, Telefon, …"
          {...fieldErrorProps('location', fieldErrors)}
        />
        <AppointmentFieldError name="location" fieldErrors={fieldErrors} />
      </div>
      <div>
        <label className="label" htmlFor={ids.notes}>
          Notizen (optional)
        </label>
        <textarea
          id={ids.notes}
          name="notes"
          rows={3}
          maxLength={4000}
          defaultValue={defaults.notes ?? undefined}
          className="input"
          {...fieldErrorProps('notes', fieldErrors)}
        />
        <AppointmentFieldError name="notes" fieldErrors={fieldErrors} />
      </div>
    </>
  );
}
