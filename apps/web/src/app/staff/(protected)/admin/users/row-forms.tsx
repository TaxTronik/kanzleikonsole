'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import Link from 'next/link';
import { KeyRound, RotateCcw, Tags } from 'lucide-react';
import {
  resetPasswordAction,
  resetTotpAction,
  setActiveAction,
  setRolesAction,
  setPermissionsAction,
} from './actions';
import { setStaffSkillsAction } from '../skills/actions';
import { STAFF_PERMISSIONS, type StaffPermissionName } from '@/lib/staff-permissions';
import { STAFF_PASSWORD_MAX_LENGTH, STAFF_PASSWORD_MIN_LENGTH } from '@/lib/staff-password-policy';

export function ToggleActiveForm({ userId, active }: { userId: string; active: boolean }) {
  const [isPending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        if (active && !confirm('Benutzer wirklich deaktivieren?')) return;
        start(async () => {
          await setActiveAction({ userId, active: !active });
        });
      }}
      className={
        active ? 'text-xs text-red-700 hover:underline' : 'text-xs text-emerald-700 hover:underline'
      }
    >
      {active ? 'Deaktivieren' : 'Aktivieren'}
    </button>
  );
}

const ROLE_OPTIONS = ['EMPLOYEE', 'PARTNER', 'ADMIN'] as const;
type Role = (typeof ROLE_OPTIONS)[number];

export function SetRolesForm({
  userId,
  currentRoles,
  disabled,
}: {
  userId: string;
  currentRoles: string[];
  disabled?: boolean;
}) {
  const [roles, setRoles] = useState<Set<string>>(new Set(currentRoles));
  const [isPending, start] = useTransition();
  const [dirty, setDirty] = useState(false);

  function toggle(role: Role) {
    setRoles((s) => {
      const next = new Set(s);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
    setDirty(true);
  }

  function save() {
    start(async () => {
      await setRolesAction({ userId, roles: Array.from(roles) as Role[] });
      setDirty(false);
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-wrap gap-1">
        {ROLE_OPTIONS.map((r) => {
          const has = roles.has(r);
          return (
            <button
              key={r}
              type="button"
              disabled={disabled}
              onClick={() => toggle(r)}
              className={
                has
                  ? 'px-2 py-0.5 rounded text-[10px] font-medium bg-brand-600 text-white'
                  : 'px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-secondary hover:bg-gray-200'
              }
              title={disabled ? 'Eigene Rollen können nicht geändert werden' : ''}
            >
              {r}
            </button>
          );
        })}
      </div>
      {dirty && !disabled && (
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="text-xs text-brand-700 hover:underline"
        >
          {isPending ? '…' : 'Speichern'}
        </button>
      )}
    </div>
  );
}

// iter87: Einzelrechte (Kurz-Chips; ADMIN/PARTNER haben implizit alles —
// dann sind die Chips ausgeblendet, siehe page.tsx). Liste + Texte aus der
// zentralen Quelle (lib/staff-permissions), nicht mehr hier kopiert.
type Permission = StaffPermissionName;

export function SetPermissionsForm({
  userId,
  currentPermissions,
}: {
  userId: string;
  currentPermissions: string[];
}) {
  const [perms, setPerms] = useState<Set<string>>(new Set(currentPermissions));
  const [isPending, start] = useTransition();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(p: Permission) {
    setPerms((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    setDirty(true);
    setError(null);
  }

  function save() {
    start(async () => {
      const res = await setPermissionsAction({
        userId,
        permissions: Array.from(perms) as Permission[],
      });
      // Nur bei Erfolg als gespeichert markieren — sonst bleibt „Speichern"
      // sichtbar und der Fehler wird angezeigt (vorher: stiller Falsch-Erfolg).
      if (res.ok) {
        setDirty(false);
        setError(null);
      } else {
        setError(res.error ?? 'Speichern fehlgeschlagen.');
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-wrap gap-1">
        {STAFF_PERMISSIONS.map((p) => {
          const has = perms.has(p.key);
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => toggle(p.key)}
              className={
                has
                  ? 'px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-600 text-white'
                  : 'px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-secondary hover:bg-gray-200'
              }
              title={p.label}
            >
              {p.short}
            </button>
          );
        })}
      </div>
      {dirty && (
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="text-xs text-brand-700 hover:underline"
        >
          {isPending ? '…' : 'Speichern'}
        </button>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

export function AccountSecurityForm({
  userId,
  isSelf,
  totpEnrolled,
  totpConfigured,
}: {
  userId: string;
  isSelf: boolean;
  totpEnrolled: boolean;
  totpConfigured: boolean;
}) {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [passwordPending, startPassword] = useTransition();
  const [totpPending, startTotp] = useTransition();

  function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startPassword(async () => {
      const result = await resetPasswordAction({
        userId,
        password,
        confirmPassword: confirmation,
      });
      if (result.ok) {
        setPassword('');
        setConfirmation('');
        setPasswordOpen(false);
        setMessage({ ok: true, text: 'Passwort gesetzt; alle Sitzungen wurden abgemeldet.' });
      } else {
        setMessage({ ok: false, text: result.error ?? 'Passwort konnte nicht gesetzt werden.' });
      }
    });
  }

  function resetTotp() {
    if (!window.confirm('2FA wirklich zurücksetzen? Der Benutzer muss sie neu einrichten.')) return;
    setMessage(null);
    startTotp(async () => {
      const result = await resetTotpAction({ userId });
      setMessage(
        result.ok
          ? { ok: true, text: '2FA zurückgesetzt; alle Sitzungen wurden abgemeldet.' }
          : { ok: false, text: result.error ?? '2FA konnte nicht zurückgesetzt werden.' },
      );
    });
  }

  if (isSelf) {
    return (
      <div className="space-y-1 text-xs">
        <Link
          href="/staff/profile"
          className="inline-flex items-center gap-1 text-brand-700 hover:underline"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Eigenes Passwort ändern
        </Link>
        <p className="text-disabled">Eigene 2FA: Reset durch weiteren Admin.</p>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setPasswordOpen((open) => !open);
            setMessage(null);
          }}
          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Passwort setzen
        </button>
        <button
          type="button"
          onClick={resetTotp}
          disabled={!totpConfigured || totpPending}
          className="inline-flex items-center gap-1 text-xs text-secondary hover:text-primary hover:underline disabled:cursor-not-allowed disabled:text-disabled disabled:no-underline"
          title={
            totpConfigured ? '2FA-Zuordnung und Backup-Codes löschen' : 'Keine 2FA eingerichtet'
          }
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {totpPending ? 'Setzt zurück…' : '2FA zurücksetzen'}
        </button>
      </div>

      {passwordOpen && (
        <form
          onSubmit={submitPassword}
          className="space-y-2 rounded-md border border-default bg-gray-50 p-3"
        >
          <label className="block text-[11px] text-muted">
            Neues Passwort
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="input mt-1"
              required
              minLength={STAFF_PASSWORD_MIN_LENGTH}
              maxLength={STAFF_PASSWORD_MAX_LENGTH}
            />
          </label>
          <label className="block text-[11px] text-muted">
            Passwort wiederholen
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              className="input mt-1"
              required
              minLength={STAFF_PASSWORD_MIN_LENGTH}
              maxLength={STAFF_PASSWORD_MAX_LENGTH}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={passwordPending}
              className="btn-primary px-2 py-1 text-xs"
            >
              {passwordPending ? 'Speichert…' : 'Speichern'}
            </button>
            <button
              type="button"
              onClick={() => setPasswordOpen(false)}
              className="text-xs text-muted hover:underline"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {message && (
        <p className={message.ok ? 'text-xs text-emerald-700' : 'text-xs text-red-700'}>
          {message.text}
        </p>
      )}
      {!totpEnrolled && totpConfigured && (
        <p className="text-[11px] text-amber-700">2FA-Einrichtung ist noch offen.</p>
      )}
    </div>
  );
}

interface SkillOption {
  id: string;
  label: string;
  color: string | null;
}

export function SetSkillsForm({
  userId,
  currentSkillIds,
  allSkills,
}: {
  userId: string;
  currentSkillIds: string[];
  allSkills: SkillOption[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(currentSkillIds));
  const [isPending, startTransition] = useTransition();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      await setStaffSkillsAction({ staffId: userId, skillIds: Array.from(selected) });
      setOpen(false);
    });
  }

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted hover:text-primary p-1"
        title="Tätigkeiten zuordnen"
        aria-label="Tätigkeiten zuordnen"
      >
        <Tags className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 z-20 rounded-lg shadow-lg border border-default bg-surface">
          <div className="px-3 py-2 border-b border-default text-xs font-medium text-secondary">
            Tätigkeiten
          </div>
          <div className="max-h-72 overflow-y-auto p-2 space-y-1">
            {allSkills.length === 0 ? (
              <p className="px-2 py-3 text-xs text-disabled">Noch keine Bereiche definiert.</p>
            ) : (
              allSkills.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="rounded border-strong text-brand-600"
                  />
                  <span className="text-primary">{s.label}</span>
                </label>
              ))
            )}
          </div>
          <div className="px-3 py-2 border-t border-default flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-muted hover:underline"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={save}
              disabled={isPending}
              className="text-xs text-brand-700 hover:underline"
            >
              {isPending ? '…' : 'Speichern'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
