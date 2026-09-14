'use client';

import { useState, useTransition } from 'react';
import { updateSkillAction, deleteSkillAction } from './actions';
import { SkillBadge } from '@/components/skill-badge';
import { confirmDialog } from '@/components/ui/modal';

interface Props {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  isSystem: boolean;
  assignments: number;
  colorHint: string;
}

const COLOR_OPTIONS = ['', 'blue', 'amber', 'emerald', 'purple', 'pink', 'red', 'yellow', 'gray'];

export function SkillRow(p: Props) {
  const [label, setLabel] = useState(p.label);
  const [color, setColor] = useState(p.color ?? '');
  const [editing, setEditing] = useState(false);
  const [isPending, start] = useTransition();

  function save() {
    start(async () => {
      await updateSkillAction({ id: p.id, label, color: color || null });
      setEditing(false);
    });
  }

  async function remove() {
    if (
      !(await confirmDialog(
        `„${p.label}" wirklich löschen? ${p.assignments} Zuordnungen werden mit gelöscht.`,
        { title: 'Kompetenz löschen', confirmLabel: 'Löschen', danger: true },
      ))
    )
      return;
    start(async () => {
      await deleteSkillAction({ id: p.id });
    });
  }

  return (
    <tr className="hover:bg-gray-50">
      <td className="min-w-56 max-w-80 px-6 py-3 [overflow-wrap:anywhere]">
        {editing ? (
          <>
            <label className="label" htmlFor={`skill-row-label-${p.id}`}>
              Anzeige-Name
            </label>
            <input
              id={`skill-row-label-${p.id}`}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="input text-sm"
              maxLength={100}
            />
          </>
        ) : (
          <span className="[&>span]:max-w-full [&>span]:rounded-md">
            <SkillBadge label={p.label} color={p.color} />
          </span>
        )}
      </td>
      <td className="px-6 py-3 font-mono text-xs text-muted">{p.slug}</td>
      <td className="px-6 py-3">
        {editing ? (
          <>
            <label className="label" htmlFor={`skill-row-color-${p.id}`}>
              Farbe
            </label>
            <select
              id={`skill-row-color-${p.id}`}
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="input text-xs"
            >
              {COLOR_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c || '— Keine —'}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-xs text-muted">{p.colorHint}</span>
        )}
      </td>
      <td className="px-6 py-3 text-secondary">{p.assignments}</td>
      <td className="px-6 py-3">
        {p.isSystem ? (
          <span className="badge-gray">System</span>
        ) : (
          <span className="badge-gray">Eigen</span>
        )}
      </td>
      <td className="px-6 py-3 text-right">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={isPending}
                className="btn-primary text-xs"
              >
                {isPending ? '…' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setLabel(p.label);
                  setColor(p.color ?? '');
                }}
                className="btn-secondary text-xs"
              >
                Abbrechen
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="btn-secondary text-xs"
              >
                Bearbeiten
              </button>
              {!p.isSystem && (
                <button
                  type="button"
                  onClick={remove}
                  disabled={isPending}
                  className="btn-danger-outline text-xs"
                >
                  Löschen
                </button>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
