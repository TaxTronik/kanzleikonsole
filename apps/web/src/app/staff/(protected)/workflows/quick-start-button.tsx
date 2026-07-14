'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Play, X } from 'lucide-react';
import { quickStartWorkflowAction } from './actions';

interface ClientOption {
  id: string;
  name: string;
}

export function QuickStartButton({
  templateId,
  templateName,
  clients,
}: {
  templateId: string;
  templateName: string;
  clients: ClientOption[];
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [clientId, setClientId] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const router = useRouter();

  function startNow() {
    if (!clientId) return;
    setError(null);
    start(async () => {
      const r = await quickStartWorkflowAction({ templateId, clientId });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Starten.');
        return;
      }
      router.push(r.redirectTo ?? `/staff/clients/${clientId}/workflows`);
    });
  }

  const filtered = search
    ? clients.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : clients;

  const modal = open ? (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="card w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary">„{templateName}" starten</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-disabled hover:text-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div>
          <label className="label">Mandant</label>
          <input
            type="text"
            placeholder="Filter — z. B. Name oder DATEV-Nr."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-sm mb-2"
          />
          <select
            size={Math.min(8, Math.max(3, filtered.length))}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="input text-sm w-full"
          >
            {filtered.length === 0 && <option disabled>— keine Treffer —</option>}
            {filtered.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="alert-error-sm text-xs p-2">{error}</div>}
        <div className="form-actions">
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary text-sm">
            Abbrechen
          </button>
          <button
            type="button"
            onClick={startNow}
            disabled={!clientId || isPending}
            className="btn-primary text-sm inline-flex items-center gap-1.5"
          >
            <Play className="h-3.5 w-3.5" />
            {isPending ? 'Starte…' : 'Workflow starten'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary text-xs inline-flex items-center gap-1"
        title="Workflow für einen Mandanten starten"
      >
        <Play className="h-3 w-3" />
        Starten
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
