'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createUserAction, type ActionResult } from './actions';

export function CreateUserForm() {
  const ref = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createUserAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="user-fullName">Name</label>
          <input id="user-fullName" name="fullName" type="text" className="input" required minLength={2} maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="user-email">E-Mail</label>
          <input id="user-email" name="email" type="email" className="input" required />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="user-password">Initial-Passwort</label>
        <input id="user-password" name="password" type="text" className="input font-mono" required minLength={12} maxLength={200} />
        <p className="text-xs text-gray-500 mt-1">
          Mindestens 12 Zeichen. Mitarbeiter wird beim ersten Login zur TOTP-Einrichtung
          aufgefordert. Übermitteln Sie das Passwort über einen sicheren Kanal.
        </p>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role.PARTNER" />
          <span>Rolle: Partner</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role.ADMIN" />
          <span>Rolle: Admin</span>
        </label>
        <span className="text-xs text-gray-500">
          (EMPLOYEE wird automatisch vergeben.)
        </span>
      </div>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">Benutzer angelegt.</div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Anlegen'}
      </button>
    </form>
  );
}
