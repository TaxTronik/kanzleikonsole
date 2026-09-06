'use client';

import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, ShieldCheck, Trash2, TriangleAlert, Usb } from 'lucide-react';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { confirmDialog } from '@/components/ui/modal';
import { fmtDateTimeMedium } from '@/lib/fmt';
import { STAFF_PASSWORD_MAX_LENGTH } from '@/lib/staff-password-policy';
import { isWebAuthnNotAllowedError } from '@/lib/webauthn-browser-error';
import {
  beginHardwareKeyRegistrationAction,
  beginHardwareModeChangeAction,
  finishHardwareKeyRegistrationAction,
  finishHardwareModeChangeAction,
  removeHardwareKeyAction,
} from './actions';

export interface HardwareKeySummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
}

interface Props {
  hardwareOnly: boolean;
  keys: HardwareKeySummary[];
  isAdmin: boolean;
}

type PendingOperation = 'register' | 'mode' | `remove:${string}` | null;

const TRANSPORT_LABELS: Record<string, string> = {
  usb: 'USB',
  nfc: 'NFC',
  ble: 'Bluetooth',
  hybrid: 'Hybrid',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unbekannt' : fmtDateTimeMedium(date);
}

function browserCeremonyError(caught: unknown, operation: 'Einrichtung' | 'Bestätigung'): string {
  if (isWebAuthnNotAllowedError(caught)) {
    return `${operation} wurde abgebrochen oder ist abgelaufen.`;
  }
  return `${operation} mit dem Sicherheitsschlüssel ist fehlgeschlagen. Bitte erneut versuchen.`;
}

function subscribeToWebAuthnSupport(): () => void {
  return () => undefined;
}

function getWebAuthnSupport(): boolean {
  return window.isSecureContext && browserSupportsWebAuthn();
}

function getServerWebAuthnSupport(): boolean {
  return true;
}

export function HardwareKeySettings({ hardwareOnly, keys, isAdmin }: Props) {
  const router = useRouter();
  const supported = useSyncExternalStore(
    subscribeToWebAuthnSupport,
    getWebAuthnSupport,
    getServerWebAuthnSupport,
  );
  const [label, setLabel] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [pending, setPending] = useState<PendingOperation>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function registerKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || supported === false) return;
    const normalizedLabel = label.trim();
    if (!normalizedLabel || !currentPassword) return;

    setMessage(null);
    setPending('register');
    try {
      const begin = await beginHardwareKeyRegistrationAction({
        label: normalizedLabel,
        currentPassword,
      });
      if ('error' in begin) {
        setMessage({ ok: false, text: begin.error });
        return;
      }

      const response = await startRegistration({ optionsJSON: begin.options });
      const result = await finishHardwareKeyRegistrationAction({
        ceremonyId: begin.ceremonyId,
        label: normalizedLabel,
        response,
      });
      if ('error' in result) {
        setMessage({ ok: false, text: result.error });
        return;
      }

      setLabel('');
      setCurrentPassword('');
      setMessage({ ok: true, text: result.success });
      if (result.forceLogout) {
        window.location.assign('/api/staff/force-logout');
        return;
      }
      router.refresh();
    } catch (caught) {
      setMessage({ ok: false, text: browserCeremonyError(caught, 'Einrichtung') });
    } finally {
      setPending(null);
    }
  }

  async function removeKey(key: HardwareKeySummary) {
    if (pending) return;
    const confirmed = await confirmDialog(
      `Sicherheitsschlüssel „${key.label}“ wirklich aus diesem Konto löschen?`,
      {
        title: 'Sicherheitsschlüssel löschen',
        confirmLabel: 'Löschen',
        danger: true,
      },
    );
    if (!confirmed) return;

    setMessage(null);
    setPending(`remove:${key.id}`);
    try {
      const result = await removeHardwareKeyAction({ credentialId: key.id });
      if ('error' in result) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: result.success });
      if (result.forceLogout) {
        window.location.assign('/api/staff/force-logout');
        return;
      }
      router.refresh();
    } catch {
      setMessage({
        ok: false,
        text: 'Der Sicherheitsschlüssel konnte nicht gelöscht werden. Bitte erneut versuchen.',
      });
    } finally {
      setPending(null);
    }
  }

  async function changeHardwareMode(enable: boolean) {
    if (pending || supported === false) return;
    const confirmed = await confirmDialog(
      enable
        ? 'Danach sind Anmeldungen ausschließlich mit einem Ihrer physischen Sicherheitsschlüssel möglich. Passwort, Authenticator-App und Wiederherstellungscodes funktionieren nicht mehr. Bewahren Sie den zweiten Schlüssel getrennt und sicher auf.'
        : 'Danach gilt wieder die Anmeldung mit Passwort und Authenticator-App. Ihre registrierten Sicherheitsschlüssel bleiben erhalten.',
      {
        title: enable ? 'Nur Sicherheitsschlüssel aktivieren' : 'Hardware-Zugang deaktivieren',
        confirmLabel: enable ? 'Aktivieren und abmelden' : 'Deaktivieren und abmelden',
        danger: enable,
      },
    );
    if (!confirmed) return;

    setMessage(null);
    setPending('mode');
    try {
      const begin = await beginHardwareModeChangeAction({ enable });
      if ('error' in begin) {
        setMessage({ ok: false, text: begin.error });
        return;
      }

      const response = await startAuthentication({ optionsJSON: begin.options });
      const result = await finishHardwareModeChangeAction({
        ceremonyId: begin.ceremonyId,
        enable,
        response,
      });
      if ('error' in result) {
        setMessage({ ok: false, text: result.error });
        return;
      }

      setMessage({ ok: true, text: result.success });
      if (result.forceLogout) {
        window.location.assign('/api/staff/force-logout');
        return;
      }
      router.refresh();
    } catch (caught) {
      setMessage({ ok: false, text: browserCeremonyError(caught, 'Bestätigung') });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card mb-6 p-6" aria-labelledby="hardware-key-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="shrink-0 rounded-lg bg-brand-100 p-2 text-brand-700">
            <KeyRound className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 id="hardware-key-heading" className="font-semibold text-primary">
              Physische Sicherheitsschlüssel
            </h2>
            <p className="mt-1 text-sm text-muted">
              FIDO2-Schlüssel mit PIN oder Biometrie ermöglichen eine phishing-resistente Anmeldung
              ohne Kontopasswort.
            </p>
          </div>
        </div>
        <span className={hardwareOnly ? 'badge-green' : 'badge-gray'}>
          {hardwareOnly ? 'Nur Sicherheitsschlüssel' : 'Optional'}
        </span>
      </div>

      {supported === false && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          Dieser Browser oder Verbindungskontext unterstützt WebAuthn nicht. Verwenden Sie einen
          aktuellen Browser über HTTPS oder wenden Sie sich an die Administration.
        </div>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-primary">
              Registrierte Schlüssel ({keys.length})
            </h3>
          </div>

          {keys.length === 0 ? (
            <p className="rounded-md border border-dashed border-default p-4 text-sm text-muted">
              Noch kein Sicherheitsschlüssel registriert.
            </p>
          ) : (
            <ul className="space-y-2">
              {keys.map((key) => {
                const transportText = key.transports
                  .map((transport) => TRANSPORT_LABELS[transport] ?? transport)
                  .join(', ');
                const removing = pending === `remove:${key.id}`;
                return (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <Usb className="mt-0.5 h-4 w-4 shrink-0 text-brand-700" aria-hidden />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-primary">{key.label}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          Erstellt {formatDate(key.createdAt)}
                          {key.lastUsedAt
                            ? ` · zuletzt verwendet ${formatDate(key.lastUsedAt)}`
                            : ''}
                          {transportText ? ` · ${transportText}` : ''}
                        </p>
                      </div>
                    </div>
                    {!hardwareOnly && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs text-red-700 hover:underline disabled:cursor-not-allowed disabled:text-disabled disabled:no-underline"
                        disabled={Boolean(pending)}
                        onClick={() => removeKey(key)}
                        aria-label={`Sicherheitsschlüssel ${key.label} löschen`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        {removing ? 'Löscht…' : 'Löschen'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {hardwareOnly ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>
                  Schlüssel können in diesem Modus nicht verändert werden. Deaktivieren Sie den
                  Hardware-Zugang zuerst mit einem registrierten Schlüssel.
                </p>
              </div>
            </div>
          ) : (
            <form
              onSubmit={registerKey}
              className="mt-4 space-y-3 rounded-md border border-default bg-gray-50 p-4"
            >
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-brand-700" aria-hidden />
                <h3 className="text-sm font-medium text-primary">
                  Sicherheitsschlüssel hinzufügen
                </h3>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-muted" htmlFor="hardware-key-label">
                  Name des Schlüssels
                  <input
                    id="hardware-key-label"
                    className="input mt-1"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    required
                    minLength={2}
                    maxLength={80}
                    placeholder="z. B. Büro oder Tresor"
                  />
                </label>
                <label className="block text-xs text-muted" htmlFor="hardware-key-password">
                  Aktuelles Passwort
                  <input
                    id="hardware-key-password"
                    className="input mt-1"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                    maxLength={STAFF_PASSWORD_MAX_LENGTH}
                  />
                </label>
              </div>
              <p className="text-xs text-muted">
                Schließen Sie einen FIDO2-Schlüssel an. Der Browser fordert anschließend PIN,
                Biometrie oder Berührung direkt am Schlüssel an.
              </p>
              <button
                type="submit"
                className="btn-secondary inline-flex items-center gap-2"
                disabled={Boolean(pending) || supported === false}
              >
                <Plus className="h-4 w-4" aria-hidden />
                {pending === 'register' ? 'Schlüssel wird eingerichtet…' : 'Schlüssel hinzufügen'}
              </button>
            </form>
          )}
        </div>

        <aside className="rounded-md border border-default bg-surface-page p-4">
          <h3 className="text-sm font-medium text-primary">Anmeldemodus</h3>
          {hardwareOnly ? (
            <>
              <p className="mt-2 text-sm text-secondary">
                Passwort, Authenticator-App und Wiederherstellungscodes sind für die Anmeldung
                deaktiviert.
              </p>
              <button
                type="button"
                className="btn-secondary mt-4 w-full"
                disabled={Boolean(pending) || supported === false}
                onClick={() => changeHardwareMode(false)}
              >
                {pending === 'mode' ? 'Wird bestätigt…' : 'Hardware-Zugang deaktivieren'}
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-secondary">
                Für reinen Hardware-Zugang sind mindestens zwei registrierte Credentials nötig. Die
                Aktivierung bestätigt einen Schlüssel; prüfen, kennzeichnen und verwahren Sie beide
                Geräte getrennt. Das System kann weder getrennte Geräteinstanzen noch die aktuelle
                Funktionsfähigkeit des zweiten Schlüssels beweisen.
              </p>
              {keys.length < 2 && (
                <div className="mt-3 flex items-start gap-2 text-xs text-amber-700">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>Noch {2 - keys.length} Schlüssel erforderlich.</span>
                </div>
              )}
              <button
                type="button"
                className="btn-primary mt-4 w-full"
                disabled={keys.length < 2 || Boolean(pending) || supported === false}
                onClick={() => changeHardwareMode(true)}
              >
                {pending === 'mode' ? 'Wird bestätigt…' : 'Nur Sicherheitsschlüssel verwenden'}
              </button>
            </>
          )}

          <p className="mt-4 border-t border-default pt-3 text-xs text-muted">
            {isAdmin
              ? 'Gehen alle Schlüssel verloren, kann dieses ADMIN-Konto ausschließlich über die Administrations-CLI wiederhergestellt werden.'
              : 'Gehen alle Schlüssel verloren, muss eine übergeordnete Rolle den Kontozugang wiederherstellen.'}
          </p>
        </aside>
      </div>

      {message && (
        <div
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'alert-success-sm mt-4' : 'alert-error-sm mt-4'}
        >
          {message.text}
        </div>
      )}
    </section>
  );
}
