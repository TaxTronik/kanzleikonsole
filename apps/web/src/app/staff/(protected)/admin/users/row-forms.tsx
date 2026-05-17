'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { Tags } from 'lucide-react';
import { setActiveAction, setRolesAction } from './actions';
import { setStaffSkillsAction } from '../skills/actions';

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
                  : 'px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 hover:bg-gray-200'
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
        className="text-xs text-gray-500 hover:text-gray-900 p-1"
        title="Tätigkeiten zuordnen"
        aria-label="Tätigkeiten zuordnen"
      >
        <Tags className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 z-20 rounded-lg shadow-lg border border-gray-200 bg-white">
          <div className="px-3 py-2 border-b border-gray-200 text-xs font-medium text-gray-700">
            Tätigkeiten
          </div>
          <div className="max-h-72 overflow-y-auto p-2 space-y-1">
            {allSkills.length === 0 ? (
              <p className="px-2 py-3 text-xs text-gray-400">
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
                    className="rounded border-gray-300 text-brand-600"
                  />
                  <span className="text-gray-900">{s.label}</span>
                </label>
              ))
            )}
          </div>
          <div className="px-3 py-2 border-t border-gray-200 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-gray-500 hover:underline"
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
