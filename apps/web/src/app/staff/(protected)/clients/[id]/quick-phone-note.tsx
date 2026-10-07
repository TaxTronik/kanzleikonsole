'use client';

import { useActionState, useRef, useState, useId } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, X, Phone } from 'lucide-react';
import { FieldError, FormErrorSummary, fieldErrorProps } from '@/components/form-errors';
import {
  createPhoneNoteAction,
  type ActionResult,
} from '@/app/staff/(protected)/phone-notes/actions';

interface Contact {
  fullName: string;
  phone: string | null;
}

interface Staff {
  id: string;
  fullName: string;
}

/**
 * Rendert den Header der Telefonzettel-Karte plus die ein-/ausklappbare
 * Inline-Form. Wird vom Mandanten-Detail oberhalb der Notizen-Liste platziert.
 * Header + Form sind Geschwister im DOM, damit die Form unter dem Header
 * fließt statt daneben.
 */
export function QuickPhoneNote({
  clientId,
  contacts,
  staff,
  currentStaffId,
}: {
  clientId: string;
  contacts: Contact[];
  staff: Staff[];
  currentStaffId: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const datalistId = useId();
  const [callerName, setCallerName] = useState('');
  const [callerPhone, setCallerPhone] = useState('');
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    async (previous, data) => {
      const result = await createPhoneNoteAction(previous, data);
      if (result.ok) {
        formRef.current?.reset();
        setCallerName('');
        setCallerPhone('');
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    null,
  );

  const fieldErrors = state?.fieldErrors;
  // Eigenes Präfix: Die Cockpit-Seite trägt weitere Formulare mit Betreff/Notiz.
  const errorProps = (name: string) => fieldErrorProps(name, fieldErrors, { prefix: 'qpn' });
  const fieldError = (name: string) => (
    <FieldError name={name} errors={fieldErrors?.[name]} prefix="qpn" />
  );

  function onCallerNameChange(value: string) {
    setCallerName(value);
    const match = contacts.find((c) => c.fullName.toLowerCase() === value.trim().toLowerCase());
    if (match?.phone && !callerPhone) setCallerPhone(match.phone);
  }

  return (
    <>
      <div className="flex items-center justify-between px-6 py-4 border-b border-default">
        <h2 className="text-sm font-medium text-primary flex items-center gap-2">
          <Phone className="h-4 w-4 text-disabled" />
          Telefonzettel
        </h2>
        <div className="flex items-center gap-3">
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn-secondary text-xs py-1"
            >
              <Plus className="h-3.5 w-3.5" />
              Neu
            </button>
          )}
          <Link href="/staff/phone-notes" className="text-xs text-brand-700 hover:underline">
            Alle →
          </Link>
        </div>
      </div>

      {open && (
        <form
          ref={formRef}
          action={formAction}
          className="border-b border-default bg-gray-50/60 px-6 py-4 space-y-3"
        >
          <input type="hidden" name="clientId" value={clientId} />
          <FormErrorSummary
            error={state?.error}
            fieldErrors={fieldErrors}
            fieldIds={{
              callerName: 'qpn-caller',
              callerPhone: 'qpn-phone',
              subject: 'qpn-subject',
              body: 'qpn-body',
              forwardToStaff: 'qpn-forward',
            }}
          />
          <datalist id={datalistId}>
            {contacts.map((c) => (
              <option key={c.fullName} value={c.fullName}>
                {c.phone ?? ''}
              </option>
            ))}
          </datalist>

          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-primary">Neuer Telefonzettel</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-disabled hover:text-primary p-1"
              aria-label="Schließen"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="qpn-caller">
                Anrufer
              </label>
              <input
                id="qpn-caller"
                name="callerName"
                type="text"
                value={callerName}
                onChange={(e) => onCallerNameChange(e.target.value)}
                list={datalistId}
                autoComplete="off"
                required
                maxLength={200}
                className="input"
                {...errorProps('callerName')}
              />
              {fieldError('callerName')}
            </div>
            <div>
              <label className="label" htmlFor="qpn-phone">
                Telefonnummer
              </label>
              <input
                id="qpn-phone"
                name="callerPhone"
                type="tel"
                value={callerPhone}
                onChange={(e) => setCallerPhone(e.target.value)}
                maxLength={50}
                className="input"
                {...errorProps('callerPhone')}
              />
              {fieldError('callerPhone')}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="qpn-subject">
              Betreff
            </label>
            <input
              id="qpn-subject"
              name="subject"
              type="text"
              required
              maxLength={200}
              className="input"
              {...errorProps('subject')}
            />
            {fieldError('subject')}
          </div>

          <div>
            <label className="label" htmlFor="qpn-body">
              Notiz
            </label>
            <textarea
              id="qpn-body"
              name="body"
              rows={3}
              required
              maxLength={5000}
              className="input text-sm"
              {...errorProps('body')}
            />
            {fieldError('body')}
          </div>

          <div>
            <label className="label" htmlFor="qpn-forward">
              Weiterleiten an
            </label>
            <select
              id="qpn-forward"
              name="forwardToStaff"
              defaultValue={currentStaffId}
              className="input"
              {...errorProps('forwardToStaff')}
            >
              <option value="">— niemand —</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
            {fieldError('forwardToStaff')}
          </div>

          <div className="flex items-center gap-2">
            <button type="submit" disabled={isPending} className="btn-primary text-sm">
              {isPending ? 'Speichert…' : 'Notiz anlegen'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={isPending}
              className="btn-secondary text-sm"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
    </>
  );
}
