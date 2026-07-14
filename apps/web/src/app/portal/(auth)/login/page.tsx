'use client';

import { useActionState } from 'react';
import { requestMagicLinkAction, type RequestLinkResult } from './actions';

export default function PortalLoginPage() {
  const [state, formAction, isPending] = useActionState<RequestLinkResult | null, FormData>(
    requestMagicLinkAction,
    null,
  );

  return (
    <>
      <div className="card p-8">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted">Mandantenportal</p>
        </div>

        {state?.ok ? (
          <div className="text-center space-y-3">
            <div className="rounded-md bg-green-50 p-4 text-sm text-green-800">
              Wenn ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Login-Link verschickt.
              Bitte prüfen Sie Ihren Posteingang.
            </div>
            <p className="text-xs text-muted">
              Der Link ist 30 Minuten gültig und kann nur einmal verwendet werden.
            </p>
          </div>
        ) : (
          <form action={formAction} className="space-y-4">
            <p className="text-sm text-secondary text-center mb-2">
              Wir senden Ihnen einen Login-Link per E-Mail.
            </p>

            <div>
              <label className="label" htmlFor="email">
                E-Mail-Adresse
              </label>
              <input
                id="email"
                name="email"
                type="email"
                className="input"
                required
                autoFocus
                autoComplete="email"
                placeholder="ihre@firma.de"
              />
            </div>

            {state?.error && <div className="alert-error-sm">{state.error}</div>}

            <button type="submit" className="btn-primary w-full" disabled={isPending}>
              {isPending ? 'Wird gesendet…' : 'Login-Link anfordern'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
