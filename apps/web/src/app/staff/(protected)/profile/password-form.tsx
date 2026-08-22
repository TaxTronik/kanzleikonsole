'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ActionResult } from '@/server/actions/staff-action';
import { STAFF_PASSWORD_MAX_LENGTH, STAFF_PASSWORD_MIN_LENGTH } from '@/lib/staff-password-policy';
import { changeOwnPasswordAction } from './actions';

export function ChangePasswordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    changeOwnPasswordAction,
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    window.location.assign('/api/staff/force-logout');
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="profile-current-password">
          Aktuelles Passwort
        </label>
        <input
          id="profile-current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          className="input"
          required
          maxLength={STAFF_PASSWORD_MAX_LENGTH}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="profile-new-password">
            Neues Passwort
          </label>
          <input
            id="profile-new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            className="input"
            required
            minLength={STAFF_PASSWORD_MIN_LENGTH}
            maxLength={STAFF_PASSWORD_MAX_LENGTH}
          />
        </div>
        <div>
          <label className="label" htmlFor="profile-confirm-password">
            Neues Passwort wiederholen
          </label>
          <input
            id="profile-confirm-password"
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

      <p className="text-xs text-muted">
        Mindestens {STAFF_PASSWORD_MIN_LENGTH} Zeichen. Nach der Änderung werden Sie auf allen
        Geräten abgemeldet und können sich mit dem neuen Passwort wieder anmelden.
      </p>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && (
        <div className="alert-success-sm">Passwort geändert. Sie werden abgemeldet…</div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending || state?.ok}>
        {isPending ? 'Passwort wird geändert…' : 'Passwort ändern'}
      </button>
    </form>
  );
}
