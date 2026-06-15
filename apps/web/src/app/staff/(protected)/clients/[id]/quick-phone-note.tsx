'use client';

import { useActionState, useEffect, useRef, useState, useId } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, X, Phone } from 'lucide-react';
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
    createPhoneNoteAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setCallerName('');
      setCallerPhone('');
      setOpen(false);
      router.refresh();
    }
  }, [router, state]);

  function onCallerNameChange(value: string) {
    setCallerName(value);
    const match = contacts.find(
      (c) => c.fullName.toLowerCase() === value.trim().toLowerCase(),
    );
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
          <datalist id={datalistId}>
            {contacts.map((c) => (
              <option key={c.fullName} value={c.fullName}>{c.phone ?? ''}</option>
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
              <label className="label" htmlFor="qpn-caller">Anrufer</label>
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
              />
            </div>
            <div>
              <label className="label" htmlFor="qpn-phone">Telefonnummer</label>
              <input
                id="qpn-phone"
                name="callerPhone"
                type="tel"
                value={callerPhone}
                onChange={(e) => setCallerPhone(e.target.value)}
                maxLength={50}
                className="input"
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="qpn-subject">Betreff</label>
            <input
              id="qpn-subject"
              name="subject"
              type="text"
              required
              maxLength={200}
              className="input"
            />
          </div>

          <div>
            <label className="label" htmlFor="qpn-body">Notiz</label>
            <textarea
              id="qpn-body"
              name="body"
              rows={3}
              required
              maxLength={5000}
              className="input text-sm"
            />
          </div>

          <div>
            <label className="label" htmlFor="qpn-forward">Weiterleiten an</label>
            <select
              id="qpn-forward"
              name="forwardToStaff"
              defaultValue={currentStaffId}
              className="input"
            >
              <option value="">— niemand —</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>{s.fullName}</option>
              ))}
            </select>
          </div>

          {state?.error && (
            <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">{state.error}</div>
          )}

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
