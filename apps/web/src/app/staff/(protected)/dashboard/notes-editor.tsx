'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { addNoteAction, updateNoteAction, deleteNoteAction } from './note-actions';
import { fmtDateTimeShort } from '@/lib/fmt';

interface Note {
  id: string;
  body: string;
  updatedAt: Date;
}


export function NotesEditor({ initial }: { initial: Note[] }) {
  const [notes, setNotes] = useState<Note[]>(initial);
  const [adding, setAdding] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function submitNew() {
    setError(null);
    const body = newBody.trim();
    if (!body) return;
    start(async () => {
      const r = await addNoteAction({ body });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      // Optimistic local update, server reload kommt per revalidatePath
      setNotes((s) => [
        { id: r.id ?? `tmp-${Date.now()}`, body, updatedAt: new Date() },
        ...s,
      ]);
      setNewBody('');
      setAdding(false);
    });
  }

  function startEdit(n: Note) {
    setEditingId(n.id);
    setEditingBody(n.body);
    setError(null);
  }

  function saveEdit() {
    if (!editingId) return;
    const id = editingId;
    const body = editingBody.trim();
    if (!body) return;
    start(async () => {
      const r = await updateNoteAction({ id, body });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setNotes((s) =>
        s.map((n) => (n.id === id ? { ...n, body, updatedAt: new Date() } : n)),
      );
      setEditingId(null);
      setEditingBody('');
    });
  }

  function remove(id: string) {
    if (!confirm('Notiz löschen?')) return;
    start(async () => {
      const r = await deleteNoteAction({ id });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setNotes((s) => s.filter((n) => n.id !== id));
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-2 border-b border-default shrink-0">
        {adding ? (
          <div className="space-y-1.5">
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Notiz…"
              autoFocus
              className="input text-sm"
            />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={submitNew}
                disabled={isPending || !newBody.trim()}
                className="btn-primary text-xs py-1"
              >
                <Check className="h-3 w-3" />
                Speichern
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewBody('');
                }}
                disabled={isPending}
                className="btn-secondary text-xs py-1"
              >
                Abbrechen
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-secondary text-xs py-1 w-full"
          >
            <Plus className="h-3.5 w-3.5" />
            Notiz hinzufügen
          </button>
        )}
      </div>

      {error && (
        <div className="px-5 py-1 text-[10px] text-red-700 dark:text-red-300">{error}</div>
      )}

      {notes.length === 0 ? (
        <div className="px-5 py-8 text-sm text-disabled text-center flex-1">
          Noch keine Notizen.
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {notes.map((n) => (
            <li key={n.id} className="px-5 py-2.5">
              {editingId === n.id ? (
                <div className="space-y-1.5">
                  <textarea
                    value={editingBody}
                    onChange={(e) => setEditingBody(e.target.value)}
                    rows={2}
                    maxLength={5000}
                    autoFocus
                    className="input text-sm"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={isPending || !editingBody.trim()}
                      className="btn-primary text-xs py-1"
                    >
                      <Check className="h-3 w-3" />
                      Speichern
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setEditingBody('');
                      }}
                      disabled={isPending}
                      className="btn-secondary text-xs py-1"
                    >
                      <X className="h-3 w-3" />
                      Abbrechen
                    </button>
                  </div>
                </div>
              ) : (
                <div className="group">
                  <p className="text-sm text-primary whitespace-pre-wrap break-words">
                    {n.body}
                  </p>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[10px] text-disabled">{fmtDateTimeShort(n.updatedAt)}</span>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEdit(n)}
                        className="text-disabled hover:text-primary p-1"
                        title="Bearbeiten"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(n.id)}
                        className="text-disabled hover:text-red-700 dark:hover:text-red-300 p-1"
                        title="Löschen"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
