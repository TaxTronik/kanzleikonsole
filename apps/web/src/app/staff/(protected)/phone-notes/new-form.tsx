'use client';

import { useActionState, useRef, useState, useId } from 'react';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';
import { FieldError, FormErrorSummary, fieldErrorProps } from '@/components/form-errors';
import { createPhoneNoteAction, type ActionResult } from './actions';

interface Caller {
  name: string;
  phone: string | null;
  /** Zuletzt zugeordneter, für den Nutzer sichtbarer Mandant. */
  client: { id: string; name: string } | null;
}

interface Props {
  staff: Array<{ id: string; fullName: string }>;
  currentStaffId: string;
  callers: Caller[];
}

export function NewPhoneNoteForm({ staff, currentStaffId, callers }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const datalistId = useId();
  const [callerName, setCallerName] = useState('');
  const [callerPhone, setCallerPhone] = useState('');
  const [client, setClient] = useState<ClientComboboxValue | null>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    async (previous, data) => {
      const result = await createPhoneNoteAction(previous, data);
      if (result.ok) {
        formRef.current?.reset();
        setCallerName('');
        setCallerPhone('');
        setClient(null);
      }
      return result;
    },
    null,
  );

  const fieldErrors = state?.fieldErrors;

  function onCallerNameChange(value: string) {
    setCallerName(value);
    const match = callers.find((c) => c.name.toLowerCase() === value.trim().toLowerCase());
    if (match) {
      if (match.phone && !callerPhone) setCallerPhone(match.phone);
      if (match.client && !client) setClient(match.client);
    }
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <FormErrorSummary
        error={state?.error}
        fieldErrors={fieldErrors}
        fieldIds={{
          callerName: 'callerName',
          callerPhone: 'callerPhone',
          subject: 'subject',
          body: 'body',
          clientId: 'clientId',
          forwardToStaff: 'forwardToStaff',
        }}
      />
      <datalist id={datalistId}>
        {callers.map((c) => (
          <option key={c.name} value={c.name}>
            {c.phone ?? ''}
          </option>
        ))}
      </datalist>

      <div>
        <label className="label" htmlFor="callerName">
          Anrufer
        </label>
        <input
          id="callerName"
          name="callerName"
          type="text"
          className="input"
          required
          maxLength={200}
          list={datalistId}
          autoComplete="off"
          value={callerName}
          onChange={(e) => onCallerNameChange(e.target.value)}
          {...fieldErrorProps('callerName', fieldErrors)}
        />
        <FieldError name="callerName" errors={fieldErrors?.callerName} />
        {callers.length > 0 && (
          <p className="text-xs text-disabled mt-1">
            Tipp: bekannte Anrufer werden vorgeschlagen, Nummer + Mandant werden übernommen.
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="callerPhone">
          Telefonnummer (optional)
        </label>
        <input
          id="callerPhone"
          name="callerPhone"
          type="tel"
          className="input"
          maxLength={50}
          value={callerPhone}
          onChange={(e) => setCallerPhone(e.target.value)}
          {...fieldErrorProps('callerPhone', fieldErrors)}
        />
        <FieldError name="callerPhone" errors={fieldErrors?.callerPhone} />
      </div>

      <div>
        <label className="label" htmlFor="subject">
          Betreff
        </label>
        <input
          id="subject"
          name="subject"
          type="text"
          className="input"
          required
          maxLength={200}
          {...fieldErrorProps('subject', fieldErrors)}
        />
        <FieldError name="subject" errors={fieldErrors?.subject} />
      </div>

      <div>
        <label className="label" htmlFor="body">
          Notiz
        </label>
        <textarea
          id="body"
          name="body"
          rows={4}
          className="input"
          required
          maxLength={5000}
          {...fieldErrorProps('body', fieldErrors)}
        />
        <FieldError name="body" errors={fieldErrors?.body} />
      </div>

      <div>
        <label className="label" htmlFor="clientId">
          Mandant (optional)
        </label>
        <ClientCombobox
          id="clientId"
          name="clientId"
          value={client}
          onChange={setClient}
          placeholder="Kein Mandant — Name, DATEV- oder Addison-Nr."
          {...fieldErrorProps('clientId', fieldErrors)}
        />
        <FieldError name="clientId" errors={fieldErrors?.clientId} />
      </div>

      <div>
        <label className="label" htmlFor="forwardToStaff">
          Weiterleiten an
        </label>
        <select
          id="forwardToStaff"
          name="forwardToStaff"
          className="input"
          defaultValue={currentStaffId}
          {...fieldErrorProps('forwardToStaff', fieldErrors)}
        >
          <option value="">— niemand —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
        <FieldError name="forwardToStaff" errors={fieldErrors?.forwardToStaff} />
      </div>

      {state?.ok && <div className="alert-success-sm">Notiz angelegt.</div>}

      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Notiz anlegen'}
      </button>
    </form>
  );
}
