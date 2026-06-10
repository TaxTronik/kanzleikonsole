'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { Tags } from 'lucide-react';
import { setActiveAction, setRolesAction, setPermissionsAction } from './actions';
import { setStaffSkillsAction } from '../skills/actions';
import { STAFF_PERMISSIONS, type StaffPermissionName } from '@/lib/staff-permissions';

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
        active
          ? 'text-xs text-red-700 hover:underline'
          : 'text-xs text-emerald-700 hover:underline'
      }
    >
      {active ? 'Deaktivieren' : 'Aktivieren'}
    </button>
  );
}

const ROLE_OPTIONS = ['EMPLOYEE', 'PARTNER', 'ADMIN'] as const;
type Role = typeof ROLE_OPTIONS[number];

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
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
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
      const res = await setPermissionsAction({ userId, permissions: Array.from(perms) as Permission[] });
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
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
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
              <p className="px-2 py-3 text-xs text-disabled">
                Noch keine Bereiche definiert.
              </p>
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
