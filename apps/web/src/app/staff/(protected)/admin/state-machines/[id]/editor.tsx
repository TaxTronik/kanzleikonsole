'use client';

import { useState, useTransition } from 'react';
import { slugify as slugifyLib } from '@/lib/slugify';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { SortableList, DragHandle } from '@/components/sortable-list';
import { saveMachineDefinitionAction } from '../actions';
import { fmtTimeMedium } from '@/lib/fmt';

interface StateDraft {
  id: string | null;
  key: string;
  label: string;
  color: string;
  isInitial: boolean;
  isTerminal: boolean;
}
interface TransitionDraft {
  fromKey: string;
  toKey: string;
  label: string;
  conditionNote: string;
}

const COLORS = ['', 'blue', 'emerald', 'amber', 'red', 'purple', 'pink', 'gray'];

// State-IDs müssen mit Buchstabe beginnen → Prefix "s"
function slugify(s: string): string {
  return slugifyLib(s, { maxLength: 40, ensureLetterStart: 's' });
}

export function MachineEditor({
  machineId,
  initialStates,
  initialTransitions,
}: {
  machineId: string;
  initialStates: StateDraft[];
  initialTransitions: TransitionDraft[];
}) {
  const [states, setStates] = useState<StateDraft[]>(initialStates);
  const [transitions, setTransitions] = useState<TransitionDraft[]>(initialTransitions);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function updateState(i: number, patch: Partial<StateDraft>) {
    setStates((s) =>
      s.map((st, idx) => {
        if (idx !== i) {
          if (patch.isInitial && st.isInitial) return { ...st, isInitial: false };
          return st;
        }
        return { ...st, ...patch };
      }),
    );
  }
  function addState() {
    setStates((s) => [
      ...s,
      { id: null, key: '', label: '', color: '', isInitial: s.length === 0, isTerminal: false },
    ]);
  }
  function removeState(i: number) {
    const key = states[i]?.key;
    if (key) {
      setTransitions((t) => t.filter((tr) => tr.fromKey !== key && tr.toKey !== key));
    }
    setStates((s) => s.filter((_, idx) => idx !== i));
  }
  function reorderStates(from: number, to: number) {
    setStates((s) => {
      const next = [...s];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  function addTransition() {
    if (states.length < 1) return;
    setTransitions((t) => [
      ...t,
      {
        fromKey: states[0]!.key,
        toKey: states[states.length - 1]!.key,
        label: '',
        conditionNote: '',
      },
    ]);
  }
  function updateTransition(i: number, patch: Partial<TransitionDraft>) {
    setTransitions((t) => t.map((tr, idx) => (idx === i ? { ...tr, ...patch } : tr)));
  }
  function removeTransition(i: number) {
    setTransitions((t) => t.filter((_, idx) => idx !== i));
  }

  function save() {
    setError(null);
    // Auto-slug aus Label, wenn key leer
    const cleaned: StateDraft[] = states
      .map((s) => ({
        ...s,
        label: s.label.trim(),
        key: s.key.trim() || slugify(s.label),
      }))
      .filter((s) => s.label || s.key);
    if (cleaned.length > 0 && cleaned.filter((s) => s.isInitial).length !== 1) {
      setError('Genau ein Anfangszustand erforderlich.');
      return;
    }
    start(async () => {
      const r = await saveMachineDefinitionAction({
        machineId,
        states: cleaned.map((s) => ({
          id: s.id,
          key: s.key,
          label: s.label || s.key,
          color: s.color || null,
          isInitial: s.isInitial,
          isTerminal: s.isTerminal,
        })),
        transitions: transitions
          .filter((t) => t.fromKey && t.toKey && t.label.trim())
          .map((t) => ({
            fromKey: t.fromKey,
            toKey: t.toKey,
            label: t.label.trim(),
            conditionNote: t.conditionNote.trim() || null,
          })),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="space-y-6">
      {/* States */}
      <div className="card p-6">
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-sm font-medium text-primary">Zustände</h2>
          <button type="button" onClick={addState} className="btn-secondary text-xs py-1">
            <Plus className="h-3.5 w-3.5" />
            Zustand
          </button>
        </div>
        {states.length === 0 ? (
          <p className="text-sm text-muted italic">Noch keine Zustände definiert.</p>
        ) : (
          <SortableList
            count={states.length}
            onReorder={reorderStates}
            renderItem={(i, handle) => {
              const s = states[i]!;
              return (
                <div className="flex items-start gap-2 p-3 border border-default rounded-md bg-surface">
                  <DragHandle handle={handle} />
                  <div className="flex-1 grid grid-cols-12 gap-2">
                    <input
                      type="text"
                      value={s.key}
                      onChange={(e) => updateState(i, { key: e.target.value.toLowerCase() })}
                      maxLength={40}
                      placeholder={slugify(s.label)}
                      className="input col-span-3 font-mono text-xs"
                      disabled={!!s.id}
                      title={s.id ? 'Key ist nach Anlage fest' : 'Technischer Schlüssel'}
                    />
                    <input
                      type="text"
                      value={s.label}
                      onChange={(e) => updateState(i, { label: e.target.value })}
                      maxLength={80}
                      placeholder="Label"
                      className="input col-span-4"
                    />
                    <select
                      value={s.color}
                      onChange={(e) => updateState(i, { color: e.target.value })}
                      className="input col-span-2 text-xs"
                    >
                      {COLORS.map((c) => (
                        <option key={c || 'none'} value={c}>
                          {c || '— Farbe —'}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs col-span-1.5">
                      <input
                        type="radio"
                        name="initial"
                        checked={s.isInitial}
                        onChange={() => updateState(i, { isInitial: true })}
                      />
                      Start
                    </label>
                    <label className="flex items-center gap-1 text-xs col-span-1.5">
                      <input
                        type="checkbox"
                        checked={s.isTerminal}
                        onChange={(e) => updateState(i, { isTerminal: e.target.checked })}
                      />
                      Final
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeState(i)}
                    className="text-disabled hover:text-red-700 p-1"
                    title="Zustand entfernen"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            }}
          />
        )}
      </div>

      {/* Transitions */}
      <div className="card p-6">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-sm font-medium text-primary">Übergänge</h2>
            <p className="text-xs text-muted">Welche Zustandswechsel sind erlaubt und wann?</p>
          </div>
          <button
            type="button"
            onClick={addTransition}
            disabled={states.length < 2}
            className="btn-secondary text-xs py-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Übergang
          </button>
        </div>
        {transitions.length === 0 ? (
          <p className="text-sm text-muted italic">Noch keine Übergänge definiert.</p>
        ) : (
          <ul className="space-y-2">
            {transitions.map((t, i) => (
              <li key={i} className="p-3 border border-default rounded-md bg-surface">
                <div className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={t.fromKey}
                    onChange={(e) => updateTransition(i, { fromKey: e.target.value })}
                    className="input col-span-3 text-sm"
                  >
                    {states.map((s) => (
                      <option key={s.key || `idx-${i}`} value={s.key}>
                        {s.label || s.key}
                      </option>
                    ))}
                  </select>
                  <div className="col-span-1 text-center text-disabled">
                    <ArrowRight className="h-4 w-4 mx-auto" />
                  </div>
                  <select
                    value={t.toKey}
                    onChange={(e) => updateTransition(i, { toKey: e.target.value })}
                    className="input col-span-3 text-sm"
                  >
                    {states.map((s) => (
                      <option key={s.key || `idx-${i}-to`} value={s.key}>
                        {s.label || s.key}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={t.label}
                    onChange={(e) => updateTransition(i, { label: e.target.value })}
                    maxLength={80}
                    placeholder="Label / Auslöser"
                    className="input col-span-4 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeTransition(i)}
                    className="text-disabled hover:text-red-700 p-1 col-span-1"
                    title="Übergang entfernen"
                  >
                    <Trash2 className="h-4 w-4 mx-auto" />
                  </button>
                </div>
                <input
                  type="text"
                  value={t.conditionNote}
                  onChange={(e) => updateTransition(i, { conditionNote: e.target.value })}
                  maxLength={300}
                  placeholder="Bedingung / Hinweis (Freitext)"
                  className="input text-xs mt-2"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Definition speichern'}
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-700">
            Gespeichert {fmtTimeMedium(new Date(savedAt))}
          </span>
        )}
      </div>
    </div>
  );
}
