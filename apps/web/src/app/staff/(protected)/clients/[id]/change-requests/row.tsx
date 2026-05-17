'use client';

import { useState, useTransition } from 'react';
import { decideChangeRequestAction } from './actions';

export function ChangeRequestRow({
  requestId,
  clientId,
}: {
  requestId: string;
  clientId: string;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function decide(approve: boolean) {
    setError(null);
    if (!approve && !note.trim()) {
      setError('Bei Ablehnung bitte einen Grund angeben.');
      return;
    }
    start(async () => {
      const r = await decideChangeRequestAction({
        requestId,
        clientId,
        approve,
        decisionNote: note.trim() || null,
      });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="border-t border-gray-100 pt-3 mt-3 space-y-2">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder="Optionale Notiz (bei Ablehnung erforderlich)"
        className="input text-sm"
      />
      {error && <div className="text-xs text-red-700">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => decide(true)}
          disabled={isPending}
          className="btn-primary text-xs py-1"
        >
          {isPending ? '…' : 'Genehmigen'}
        </button>
        <button
          type="button"
          onClick={() => decide(false)}
          disabled={isPending}
          className="btn-secondary text-xs py-1"
        >
          Ablehnen
        </button>
      </div>
    </div>
  );
}
