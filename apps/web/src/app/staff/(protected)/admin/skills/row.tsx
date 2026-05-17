'use client';

import { useState, useTransition } from 'react';
import { updateSkillAction, deleteSkillAction } from './actions';
import { SkillBadge } from '@/components/skill-badge';

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

  function remove() {
    if (!confirm(`„${p.label}" wirklich löschen? ${p.assignments} Zuordnungen werden mit gelöscht.`)) return;
    start(async () => {
      await deleteSkillAction({ id: p.id });
    });
  }

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-3">
        {editing ? (
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="input text-sm"
            maxLength={100}
          />
        ) : (
          <SkillBadge label={p.label} color={p.color} />
        )}
      </td>
      <td className="px-6 py-3 font-mono text-xs text-gray-500">{p.slug}</td>
      <td className="px-6 py-3">
        {editing ? (
          <select
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="input text-xs"
          >
            {COLOR_OPTIONS.map((c) => (
              <option key={c} value={c}>{c || '— Keine —'}</option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-gray-500">{p.colorHint}</span>
        )}
      </td>
      <td className="px-6 py-3 text-gray-700">{p.assignments}</td>
      <td className="px-6 py-3">
        {p.isSystem ? (
          <span className="badge-gray">System</span>
        ) : (
          <span className="badge-gray">Eigen</span>
        )}
      </td>
      <td className="px-6 py-3 text-right">
        <div className="flex items-center justify-end gap-3">
          {editing ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={isPending}
                className="text-xs text-brand-700 hover:underline"
              >
                {isPending ? '…' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setLabel(p.label); setColor(p.color ?? ''); }}
                className="text-xs text-gray-500 hover:underline"
              >
                Abbrechen
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-gray-600 hover:underline"
              >
                Bearbeiten
              </button>
              {!p.isSystem && (
                <button
                  type="button"
                  onClick={remove}
                  disabled={isPending}
                  className="text-xs text-red-700 hover:underline"
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
