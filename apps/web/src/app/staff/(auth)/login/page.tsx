'use client';

import { useEffect, useState, useSyncExternalStore, useTransition, type SubmitEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { isWebAuthnNotAllowedError } from '@/lib/webauthn-browser-error';
import {
  beginHardwareLoginAction,
  checkPasswordAction,
  confirmTotpEnrollmentAction,
  hardwareLoginAvailabilityAction,
  loginAction,
  loginHardwareAction,
} from './actions';

/**
 * V-4: returnTo aus den Query-Params validieren, bevor wir nach Login dorthin
 * springen. Nur same-origin-Pfade unter /staff/ zugelassen — kein //example.com,
 * keine `javascript:`-URLs, kein Cross-Surface-Redirect ins Portal.
 * Symmetrische Validierung im Portal-Login-Pfad (Whitelist `/portal/`).
 */
function safeStaffReturnTo(raw: string | null): string {
  if (!raw) return '/staff/dashboard';
  // Protocol-relative `//evil.com/...` oder absoluter https-Pfad → ablehnen.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/staff/dashboard';
  // Nur /staff/* — verhindert /portal/-Hop oder /api/-Echos.
  if (!raw.startsWith('/staff/')) return '/staff/dashboard';
  // Backslash-Trick mancher Browser → ablehnen.
  if (raw.includes('\\')) return '/staff/dashboard';
  return raw;
}

type Step = 'password' | 'totp' | 'setup' | 'setup-confirm' | 'backup-codes';

function subscribeToWebAuthnSupport(): () => void {
  return () => undefined;
}

function getWebAuthnSupport(): boolean {
  return window.isSecureContext && browserSupportsWebAuthn();
}

function getServerWebAuthnSupport(): boolean {
  // Ohne Hydrierung kann der Button keine Browser-Zeremonie starten.
  return false;
}

export default function StaffLoginPage() {
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [setupQrDataUrl, setSetupQrDataUrl] = useState('');
  // V-1: Backup-Codes werden NUR EINMAL nach erfolgreichem TOTP-Enroll
  // angezeigt. Wir halten sie nur im Client-State — kein Storage, kein
  // erneuter Server-Roundtrip.
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hardwarePending, setHardwarePending] = useState(false);
  const [hardwareAvailable, setHardwareAvailable] = useState(false);
  const [isPending, startTransition] = useTransition();
  const hardwareSupported = useSyncExternalStore(
    subscribeToWebAuthnSupport,
    getWebAuthnSupport,
    getServerWebAuthnSupport,
  );

  const searchParams = useSearchParams();
  const returnTo = safeStaffReturnTo(searchParams.get('returnTo'));

  const tenantSlug = 'default';

  useEffect(() => {
    let active = true;
    void hardwareLoginAvailabilityAction()
      .then(({ available }) => {
        if (active) setHardwareAvailable(available);
      })
      .catch(() => {
        if (active) setHardwareAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submitHardwareLogin() {
    if (hardwarePending || isPending || hardwareSupported === false) return;
    setError(null);
    setHardwarePending(true);
    try {
      const begin = await beginHardwareLoginAction();
      if ('error' in begin) {
        setError(begin.error);
        return;
      }

      const response = await startAuthentication({ optionsJSON: begin.options });
      const result = await loginHardwareAction({
        ceremonyId: begin.ceremonyId,
        response,
        returnTo,
      });
      if (result?.error) setError(result.error);
    } catch (caught) {
      // Erfolgreiche Server-Action-Redirects müssen Next.js erreichen. Browser-
      // Abbruch und Timeout liefern beide NotAllowedError und erhalten bewusst
      // dieselbe, nicht kontobezogene Meldung.
      if (
        caught &&
        typeof caught === 'object' &&
        'digest' in caught &&
        typeof caught.digest === 'string' &&
        caught.digest.startsWith('NEXT_REDIRECT')
      ) {
        throw caught;
      }
      setError(
        isWebAuthnNotAllowedError(caught)
          ? 'Die Anmeldung mit Sicherheitsschlüssel wurde abgebrochen oder ist abgelaufen.'
          : 'Die Anmeldung mit Sicherheitsschlüssel ist fehlgeschlagen. Bitte erneut versuchen.',
      );
    } finally {
      setHardwarePending(false);
    }
  }

  function submitPasswordStep() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await checkPasswordAction(email, password, tenantSlug);
      if (!result.ok) {
        setError(result.error ?? 'Fehler bei der Anmeldung.');
        return;
      }
      // DEV-ONLY: TOTP übersprungen → direkt einloggen (ohne Code/Setup).
      if (result.devSkip) {
        const fd = new FormData();
        fd.set('email', email);
        fd.set('password', password);
        fd.set('tenantSlug', tenantSlug);
        fd.set('returnTo', returnTo);
        const login = await loginAction(fd);
        if (login.error) setError(login.error);
        return;
      }
      if (result.totpRequired) {
        setStep('totp');
      } else if (result.totpSetupRequired) {
        setSetupSecret(result.setupSecret ?? '');
        setSetupQrDataUrl(result.setupQrDataUrl ?? '');
        setStep('setup');
      }
    });
  }

  function handlePasswordSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    submitPasswordStep();
  }

  function handleSetupConfirm(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await confirmTotpEnrollmentAction(email, password, totpCode, tenantSlug);
      if (!result.ok) {
        setError(result.error ?? 'Bestätigung fehlgeschlagen.');
        return;
      }
      setTotpCode('');
      // V-1: Wenn der Server frische Backup-Codes mitschickt, zeigen wir sie
      // EINMAL als Recovery-Pflicht-Schritt. Erst nach Bestätigung („habe ich
      // notiert") geht es zum normalen TOTP-Login.
      if (result.backupCodes && result.backupCodes.length > 0) {
        setBackupCodes(result.backupCodes);
        setStep('backup-codes');
      } else {
        setStep('totp');
      }
    });
  }

  function downloadBackupCodes() {
    const text =
      'Mitarbeiter-Login — TOTP-Backup-Codes\n' +
      '=======================================\n\n' +
      `Mitarbeiter: ${email}\n` +
      `Erstellt:    ${new Date().toLocaleString('de-DE')}\n\n` +
      'Diese Codes sind Einmal-Codes für den Fall, dass das Authenticator-\n' +
      'Gerät verloren geht. Bitte sicher aufbewahren (Passwort-Manager,\n' +
      'verschlossener Tresor). Werden nicht erneut angezeigt.\n\n' +
      backupCodes.map((c, i) => `${(i + 1).toString().padStart(2, '0')}. ${c}`).join('\n') +
      '\n';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mitarbeiter-login-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* Card */}
      <div className="card p-8">
        {/* Das Kanzlei-Logo beziehungsweise der Kanzleiname steht im Auth-Layout. */}
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-primary">Mitarbeiter-Login</h1>
        </div>

        {/* Step: Passwort */}
        {step === 'password' && (
          <div className="space-y-4">
            {error && (
              <div role="alert" className="alert-error-sm">
                {error}
              </div>
            )}
            {hardwareAvailable && (
              <>
                <div className="space-y-2">
                  <button
                    type="button"
                    className="btn-primary flex w-full items-center justify-center gap-2"
                    disabled={hardwarePending || isPending || hardwareSupported === false}
                    onClick={submitHardwareLogin}
                    aria-describedby={
                      hardwareSupported === false ? 'hardware-login-support' : undefined
                    }
                  >
                    <KeyRound className="h-4 w-4" aria-hidden />
                    {hardwarePending
                      ? 'Sicherheitsschlüssel wird geprüft…'
                      : 'Mit Sicherheitsschlüssel anmelden'}
                  </button>
                  {hardwarePending && (
                    <p role="status" className="text-center text-xs text-muted">
                      Folgen Sie dem Hinweis Ihres Browsers und berühren Sie Ihren Schlüssel.
                    </p>
                  )}
                  {hardwareSupported === false && (
                    <p id="hardware-login-support" className="text-center text-xs text-amber-700">
                      Sicherheitsschlüssel erfordern JavaScript und einen unterstützten Browser über
                      HTTPS.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3" aria-hidden>
                  <span className="h-px flex-1 bg-gray-200" />
                  <span className="text-xs text-muted">
                    oder mit Passwort und Authenticator-App
                  </span>
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              </>
            )}

            <form
              onSubmit={handlePasswordSubmit}
              method="post"
              action={`/staff/login/password?returnTo=${encodeURIComponent(returnTo)}`}
              className="space-y-4"
            >
              <input type="hidden" name="tenantSlug" value={tenantSlug} />
              <div>
                <label className="label" htmlFor="email">
                  E-Mail
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="max@kanzlei.de"
                />
              </div>
              <div>
                <label className="label" htmlFor="password">
                  Passwort
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <button
                type="submit"
                className="btn-secondary w-full"
                disabled={isPending || hardwarePending}
              >
                {isPending ? 'Wird geprüft…' : 'Weiter'}
              </button>
            </form>
          </div>
        )}

        {/* Step: TOTP-Code eingeben */}
        {step === 'totp' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              setError(null);
              startTransition(async () => {
                const result = await loginAction(fd);
                if (result.error) {
                  setError(result.error);
                }
              });
            }}
            className="space-y-4"
          >
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="password" value={password} />
            <input type="hidden" name="tenantSlug" value={tenantSlug} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <p className="text-sm text-secondary text-center mb-4">
              Gib den 6-stelligen Code aus deiner Authenticator-App ein.
            </p>
            <div>
              <label className="label" htmlFor="totpCode">
                TOTP-Code
              </label>
              <input
                id="totpCode"
                name="totpCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                className="input text-center text-2xl tracking-widest"
                placeholder="000000"
                autoFocus
                autoComplete="one-time-code"
              />
            </div>
            {error && <div className="alert-error-sm">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={isPending}>
              {isPending ? 'Wird geprüft…' : 'Anmelden'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep('password');
                setError(null);
              }}
              className="btn-secondary w-full"
            >
              Zurück
            </button>
          </form>
        )}

        {/* Step: TOTP-Setup — QR-Code anzeigen */}
        {step === 'setup' && (
          <div className="space-y-4">
            <div className="text-center">
              <p className="text-sm font-medium text-primary mb-1">
                Zwei-Faktor-Authentifizierung einrichten
              </p>
              <p className="text-sm text-muted">
                Scanne den QR-Code mit einer Authenticator-App (z.&nbsp;B. Google Authenticator,
                Authy).
              </p>
            </div>

            {/* Q-1: QR-Code serverseitig erzeugt (data:image/png). Vorher lief
                  der Render über api.qrserver.com — Drittanbieter hätte das
                  TOTP-Secret im Klartext bekommen, faktisch durch CSP geblockt
                  und Setup-Flow kaputt. Jetzt: lokal via npm `qrcode`. */}
            <div className="flex justify-center my-4">
              <div className="border border-default rounded-lg p-3 bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element -- TOTP QR code is a local data URL; Next image optimization is not useful here. */}
                <img src={setupQrDataUrl} alt="TOTP QR-Code" width={180} height={180} />
              </div>
            </div>

            <div className="bg-gray-50 rounded-md p-3 text-center">
              <p className="text-xs text-muted mb-1">Oder Secret manuell eingeben:</p>
              <code className="text-sm font-mono text-primary break-all">{setupSecret}</code>
            </div>

            <button
              type="button"
              onClick={() => {
                setStep('setup-confirm');
                setError(null);
                setTotpCode('');
              }}
              className="btn-primary w-full"
            >
              QR-Code gescannt — weiter
            </button>
          </div>
        )}

        {/* Step: Setup-Bestätigung */}
        {step === 'setup-confirm' && (
          <form onSubmit={handleSetupConfirm} className="space-y-4">
            <p className="text-sm text-secondary text-center">
              Gib den 6-stelligen Code aus deiner Authenticator-App ein, um die Einrichtung zu
              bestätigen.
            </p>
            <div>
              <label className="label" htmlFor="confirmCode">
                Bestätigungs-Code
              </label>
              <input
                id="confirmCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                className="input text-center text-2xl tracking-widest"
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                autoFocus
              />
            </div>
            {error && <div className="alert-error-sm">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={isPending}>
              {isPending ? 'Wird bestätigt…' : 'Bestätigen und anmelden'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep('setup');
                setError(null);
              }}
              className="btn-secondary w-full"
            >
              Zurück zum QR-Code
            </button>
          </form>
        )}

        {/* V-1: Backup-Codes nach Erst-Enrollment — wird NUR EINMAL angezeigt */}
        {step === 'backup-codes' && (
          <div className="space-y-4">
            <div className="text-center">
              <p className="text-sm font-medium text-primary mb-1">Recovery-Codes</p>
              <p className="text-sm text-muted">
                Falls dein Authenticator-Gerät verloren geht, kannst du dich mit einem dieser Codes
                einmalig anmelden.
              </p>
            </div>
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800 border border-yellow-200">
              <strong>Wichtig:</strong> Diese Codes werden <strong>nicht erneut angezeigt</strong>.
              Bitte jetzt herunterladen oder ausdrucken und sicher aufbewahren (Passwort-Manager,
              verschlossener Tresor).
            </div>
            <div className="rounded-md bg-gray-50 p-4 font-mono text-sm grid grid-cols-2 gap-2">
              {backupCodes.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-disabled w-6 text-right">
                    {(i + 1).toString().padStart(2, '0')}.
                  </span>
                  <span className="text-primary">{c}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={downloadBackupCodes} className="btn-secondary w-full">
              Als Textdatei herunterladen
            </button>
            <button
              type="button"
              onClick={() => {
                // Bewusst die Codes aus dem State löschen, sobald der User
                // weiter klickt — sie sind dann nur noch in der Datei /
                // beim User.
                setBackupCodes([]);
                setStep('totp');
              }}
              className="btn-primary w-full"
            >
              Codes notiert — weiter zum Login
            </button>
          </div>
        )}
      </div>
    </>
  );
}
