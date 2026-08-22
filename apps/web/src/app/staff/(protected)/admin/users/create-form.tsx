'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createUserAction } from './actions';
import type { ActionResult } from '@/server/actions/staff-action';
import { STAFF_PASSWORD_MAX_LENGTH, STAFF_PASSWORD_MIN_LENGTH } from '@/lib/staff-password-policy';

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
          <label className="label" htmlFor="user-fullName">
            Name
          </label>
          <input
            id="user-fullName"
            name="fullName"
            type="text"
            className="input"
            required
            minLength={2}
            maxLength={200}
          />
        </div>
        <div>
          <label className="label" htmlFor="user-email">
            E-Mail
          </label>
          <input id="user-email" name="email" type="email" className="input" required />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="user-password">
            Initial-Passwort
          </label>
          <input
            id="user-password"
            name="password"
            type="password"
            autoComplete="new-password"
            className="input"
            required
            minLength={STAFF_PASSWORD_MIN_LENGTH}
            maxLength={STAFF_PASSWORD_MAX_LENGTH}
          />
        </div>
        <div>
          <label className="label" htmlFor="user-confirm-password">
            Initial-Passwort wiederholen
          </label>
          <input
            id="user-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            className="input"
            required
            minLength={STAFF_PASSWORD_MIN_LENGTH}
            maxLength={STAFF_PASSWORD_MAX_LENGTH}
          />
        </div>
      </div>
      <div>
        <p className="text-xs text-muted mt-1">
          Mindestens {STAFF_PASSWORD_MIN_LENGTH} Zeichen. Der Benutzer kann es anschließend im
          Benutzerprofil ändern und richtet beim ersten Login TOTP ein. Übermitteln Sie das
          Initial-Passwort über einen sicheren Kanal.
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
        <span className="text-xs text-muted">(EMPLOYEE wird automatisch vergeben.)</span>
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && <div className="alert-success-sm">Benutzer angelegt.</div>}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Anlegen'}
      </button>
    </form>
  );
}
