'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import {
  NewRequestForm,
  type RequestClientOption,
  type RequestFormTemplateOption,
  type RequestTemplateOption,
} from '@/app/staff/(protected)/clients/[id]/requests/new/form';

interface Props {
  requestId: string;
  client?: RequestClientOption;
  templates: RequestTemplateOption[];
  formTemplates: RequestFormTemplateOption[];
  templatesLimited?: boolean;
  formTemplatesLimited?: boolean;
  buttonLabel?: string;
  buttonClassName?: string;
}

/**
 * Öffnet die sichere Anforderungsanlage ohne Navigation. Die eigentliche
 * Erstellung bleibt eine explizite zweite Bestätigung im vollständig
 * ausgefüllten Formular — der Öffnen-Klick versendet niemals etwas.
 */
export function QuickRequestDialog({
  requestId,
  client,
  templates,
  formTemplates,
  templatesLimited = false,
  formTemplatesLimited = false,
  buttonLabel = 'Anforderung erstellen',
  buttonClassName = 'btn-primary',
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [requestIdState, setRequestIdState] = useState({ source: requestId, current: requestId });
  const currentRequestId = requestIdState.source === requestId ? requestIdState.current : requestId;

  const close = useCallback(() => {
    if (!pending) setOpen(false);
  }, [pending]);
  const handleCreated = useCallback(
    (result: { nextRequestId: string }) => {
      setRequestIdState({ source: requestId, current: result.nextRequestId });
      setCreated(true);
      setPending(false);
      setOpen(false);
      router.refresh();
    },
    [requestId, router],
  );

  return (
    <>
      <div className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          className={buttonClassName}
          onClick={() => {
            setCreated(false);
            setOpen(true);
          }}
          aria-haspopup="dialog"
        >
          <Plus className="h-4 w-4" />
          {buttonLabel}
        </button>
        {created && (
          <span role="status" className="text-xs text-emerald-700">
            Anforderung erstellt.
          </span>
        )}
      </div>

      {open && (
        <Modal title="Anforderung erstellen" onClose={close} maxWidth="max-w-2xl">
          <div className="max-h-[calc(100vh-5rem)] overflow-y-auto pr-1">
            <h2 className="text-lg font-semibold text-primary mb-1">Anforderung erstellen</h2>
            <p className="text-sm text-muted mb-4">
              {client?.allowActive
                ? `An ${client.name}. Prüfen Sie die Angaben vor dem Erstellen.`
                : client
                  ? `${client.name} ist noch nicht aktiv. Eine Portal-Anforderung ist erst nach abgeschlossener GwG-Prüfung möglich.`
                  : 'Suchen und wählen Sie den Mandanten direkt aus. Mandanten mit offener GwG-Prüfung werden mit ihrem Status angezeigt.'}
            </p>
            <NewRequestForm
              requestId={currentRequestId}
              clientId={client?.id}
              disabled={client ? !client.allowActive : false}
              templates={templates}
              formTemplates={formTemplates}
              templatesLimited={templatesLimited}
              formTemplatesLimited={formTemplatesLimited}
              mode="quick"
              autoFocus
              onPendingChange={setPending}
              onCreated={handleCreated}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
