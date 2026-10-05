'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Play, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';
import { quickStartWorkflowAction } from './actions';

export function QuickStartButton({
  templateId,
  templateName,
}: {
  templateId: string;
  templateName: string;
}) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState<ClientComboboxValue | null>(null);
  const clientId = client?.id ?? '';
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

  const modal = open ? (
    <Modal
      title={`„${templateName}" starten`}
      onClose={() => setOpen(false)}
      panelClassName="card w-full max-w-md p-5 space-y-3"
      showCloseButton={false}
      closeDisabled={isPending}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-primary">„{templateName}" starten</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-disabled hover:text-secondary"
          aria-label="Dialog schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div>
        <label className="label" htmlFor={`quick-start-${templateId}-client`}>
          Mandant auswählen
        </label>
        {/* Serversuche mit Zugriffsregel statt des ungefilterten Gesamtbestands. */}
        <ClientCombobox
          id={`quick-start-${templateId}-client`}
          value={client}
          onChange={setClient}
        />
      </div>
      {error && (
        <div className="alert-error-sm text-xs p-2" role="alert">
          {error}
        </div>
      )}
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
    </Modal>
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
      {modal}
    </>
  );
}
