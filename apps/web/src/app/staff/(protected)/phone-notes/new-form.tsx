'use client';

import { useActionState, useRef, useEffect, useState, useId } from 'react';
import { createPhoneNoteAction, type ActionResult } from './actions';

interface Caller {
  name: string;
  phone: string | null;
  clientId: string | null;
}

interface Props {
  clients: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; fullName: string }>;
  currentStaffId: string;
  callers: Caller[];
}

export function NewPhoneNoteForm({ clients, staff, currentStaffId, callers }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const datalistId = useId();
  const [callerName, setCallerName] = useState('');
  const [callerPhone, setCallerPhone] = useState('');
  const [clientId, setClientId] = useState('');
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createPhoneNoteAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setCallerName('');
      setCallerPhone('');
      setClientId('');
    }
  }, [state]);

  function onCallerNameChange(value: string) {
    setCallerName(value);
    const match = callers.find((c) => c.name.toLowerCase() === value.trim().toLowerCase());
    if (match) {
      if (match.phone && !callerPhone) setCallerPhone(match.phone);
      if (match.clientId && !clientId) setClientId(match.clientId);
    }
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <datalist id={datalistId}>
        {callers.map((c) => (
          <option key={c.name} value={c.name}>{c.phone ?? ''}</option>
        ))}
      </datalist>

      <div>
        <label className="label" htmlFor="callerName">Anrufer</label>
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
        />
        {callers.length > 0 && (
          <p className="text-xs text-gray-400 mt-1">
            Tipp: bekannte Anrufer werden vorgeschlagen, Nummer + Mandant werden übernommen.
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="callerPhone">Telefonnummer (optional)</label>
        <input
          id="callerPhone"
          name="callerPhone"
          type="tel"
          className="input"
          maxLength={50}
          value={callerPhone}
          onChange={(e) => setCallerPhone(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="subject">Betreff</label>
        <input
          id="subject"
          name="subject"
          type="text"
          className="input"
          required
          maxLength={200}
        />
      </div>

      <div>
        <label className="label" htmlFor="body">Notiz</label>
        <textarea
          id="body"
          name="body"
          rows={4}
          className="input"
          required
          maxLength={5000}
        />
      </div>

      <div>
        <label className="label" htmlFor="clientId">Mandant (optional)</label>
        <select
          id="clientId"
          name="clientId"
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        >
          <option value="">— kein Mandant —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="forwardToStaff">Weiterleiten an</label>
        <select
          id="forwardToStaff"
          name="forwardToStaff"
          className="input"
          defaultValue={currentStaffId}
        >
          <option value="">— niemand —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>{s.fullName}</option>
          ))}
        </select>
      </div>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          Notiz angelegt.
        </div>
      )}

      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Notiz anlegen'}
      </button>
    </form>
  );
}
