'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X, CalendarPlus, Trash2 } from 'lucide-react';
import { DateTimePicker } from '@/components/datetime-picker';
import {
  FieldError,
  FormErrorSummary,
  fieldErrorId,
  fieldErrorProps,
} from '@/components/form-errors';
import { createAppointmentRequestAction, type AppointmentRequestActionResult } from './actions';

interface StaffOption {
  id: string;
  fullName: string;
}

/** Lokaler `YYYY-MM-DDTHH:MM`-Stempel für <input type="datetime-local">. */
function toLocalIsoMinute(d: Date): string {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultStartFor(slotIndex: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1 + slotIndex);
  d.setHours(10, 0, 0, 0);
  return toLocalIsoMinute(d);
}

function defaultEndFor(slotIndex: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1 + slotIndex);
  d.setHours(11, 0, 0, 0);
  return toLocalIsoMinute(d);
}

export function AppointmentRequestForm({ staffOptions }: { staffOptions: StaffOption[] }) {
  const router = useRouter();
  const [slotCount, setSlotCount] = useState(1);
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<
    AppointmentRequestActionResult | null,
    FormData
  >(async (previous, data) => {
    const result = await createAppointmentRequestAction(previous, data);
    if (result.ok) {
      setOpen(false);
      setSlotCount(1);
      router.refresh();
    }
    return result;
  }, null);

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-default flex items-center justify-between">
        <h2 className="text-sm font-medium text-primary flex items-center gap-2">
          <CalendarPlus className="h-4 w-4 text-disabled" />
          Neuen Termin anfragen
        </h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="btn-primary text-xs inline-flex items-center gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Anfragen
          </button>
        )}
      </div>

      {open && (
        <form action={formAction} className="p-5 space-y-4" aria-busy={isPending}>
          <FormErrorSummary
            error={state?.error}
            fieldErrors={state?.fieldErrors}
            fieldIds={{
              subject: 'appointment-request-subject',
              preferredStaffId: 'appointment-request-preferred-staff',
              notes: 'appointment-request-notes',
              ...Object.fromEntries(
                Array.from({ length: slotCount }).flatMap((_, index) => [
                  [`slot${index}_starts`, `appointment-slot-${index}-starts`],
                  [`slot${index}_ends`, `appointment-slot-${index}-ends`],
                ]),
              ),
            }}
          />
          <div>
            <label className="label" htmlFor="appointment-request-subject">
              Anliegen / Betreff
            </label>
            <input
              id="appointment-request-subject"
              type="text"
              name="subject"
              required
              maxLength={200}
              className="input"
              placeholder='z. B. „Bilanzbesprechung", „Beratung Existenzgründung"'
              {...fieldErrorProps('subject', state?.fieldErrors)}
            />
            <FieldError name="subject" errors={state?.fieldErrors?.subject} />
          </div>

          <div>
            <label className="label" htmlFor="appointment-request-preferred-staff">
              Wunsch-Bearbeiter (optional)
            </label>
            <select
              id="appointment-request-preferred-staff"
              name="preferredStaffId"
              defaultValue=""
              className="input"
              {...fieldErrorProps('preferredStaffId', state?.fieldErrors, {
                describedBy: 'appointment-request-preferred-staff-hint',
              })}
            >
              <option value="">— egal —</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
            <p
              id="appointment-request-preferred-staff-hint"
              className="text-[11px] text-muted mt-1"
            >
              Ohne Auswahl entscheidet die Kanzlei, wer den Termin übernimmt.
            </p>
            <FieldError name="preferredStaffId" errors={state?.fieldErrors?.preferredStaffId} />
          </div>

          <fieldset className="space-y-3">
            <legend className="label">Wunschtermine (bis zu 3)</legend>
            {Array.from({ length: slotCount }).map((_, i) => (
              <div
                key={i}
                className="rounded-md border border-default p-3 space-y-2 bg-gray-50/40 dark:bg-gray-900/30"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-secondary">Wunsch {i + 1}</span>
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => setSlotCount((c) => Math.max(1, c - 1))}
                      className="text-disabled hover:text-red-700 p-1"
                      title="Diesen Wunsch entfernen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label
                      className="text-[11px] text-muted block mb-1"
                      htmlFor={`appointment-slot-${i}-starts`}
                    >
                      Beginn
                    </label>
                    <DateTimePicker
                      id={`appointment-slot-${i}-starts`}
                      name={`slot${i}_starts`}
                      defaultValue={defaultStartFor(i)}
                      required
                      minDate={new Date()}
                      ariaInvalid={Boolean(state?.fieldErrors?.[`slot${i}_starts`]?.length)}
                      ariaDescribedBy={
                        state?.fieldErrors?.[`slot${i}_starts`]?.length
                          ? fieldErrorId(`slot${i}_starts`)
                          : undefined
                      }
                    />
                    <FieldError
                      name={`slot${i}_starts`}
                      errors={state?.fieldErrors?.[`slot${i}_starts`]}
                    />
                  </div>
                  <div>
                    <label
                      className="text-[11px] text-muted block mb-1"
                      htmlFor={`appointment-slot-${i}-ends`}
                    >
                      Ende
                    </label>
                    <DateTimePicker
                      id={`appointment-slot-${i}-ends`}
                      name={`slot${i}_ends`}
                      defaultValue={defaultEndFor(i)}
                      required
                      minDate={new Date()}
                      ariaInvalid={Boolean(state?.fieldErrors?.[`slot${i}_ends`]?.length)}
                      ariaDescribedBy={
                        state?.fieldErrors?.[`slot${i}_ends`]?.length
                          ? fieldErrorId(`slot${i}_ends`)
                          : undefined
                      }
                    />
                    <FieldError
                      name={`slot${i}_ends`}
                      errors={state?.fieldErrors?.[`slot${i}_ends`]}
                    />
                  </div>
                </div>
              </div>
            ))}
            {slotCount < 3 && (
              <button
                type="button"
                onClick={() => setSlotCount((c) => c + 1)}
                className="text-xs text-brand-700 inline-flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                Weiteren Wunschtermin hinzufügen
              </button>
            )}
          </fieldset>

          <div>
            <label className="label" htmlFor="appointment-request-notes">
              Notiz (optional)
            </label>
            <textarea
              id="appointment-request-notes"
              name="notes"
              rows={3}
              maxLength={2000}
              className="input"
              placeholder="Worum geht es? Wer ist dabei? Online oder vor Ort?"
              {...fieldErrorProps('notes', state?.fieldErrors)}
            />
            <FieldError name="notes" errors={state?.fieldErrors?.notes} />
          </div>
          {state && state.ok && (
            <p className="text-xs text-emerald-700" role="status" aria-live="polite">
              Anfrage verschickt — die Kanzlei meldet sich.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSlotCount(1);
              }}
              className="btn-secondary text-sm inline-flex items-center gap-1"
            >
              <X className="h-3.5 w-3.5" />
              Abbrechen
            </button>
            <button type="submit" disabled={isPending} className="btn-primary text-sm">
              {isPending ? 'Sende…' : 'Anfrage senden'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
