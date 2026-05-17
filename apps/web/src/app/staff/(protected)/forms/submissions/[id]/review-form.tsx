'use client';

import { useState, useTransition } from 'react';
import { reviewSubmissionAction } from '../../actions';

export function ReviewForm({ id }: { id: string }) {
  const [notes, setNotes] = useState('');
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    start(async () => {
      const r = await reviewSubmissionAction({ id, notes: notes.trim() || undefined });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="card p-4 space-y-3">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Notiz zur Prüfung (optional)"
        className="input"
      />
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Als geprüft markieren'}
        </button>
      </div>
    </div>
  );
}
