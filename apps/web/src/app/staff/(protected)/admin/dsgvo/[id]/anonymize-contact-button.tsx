'use client';

import { useState } from 'react';
import { UserX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ConfirmModal } from '@/components/ui/modal';
import { anonymizeContactAction } from '../actions';

function actionError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Der Portal-Kontakt konnte nicht anonymisiert werden.';
}

export function AnonymizeContactButton({
  contactId,
  subjectName,
}: {
  contactId: string;
  subjectName: string;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function anonymize(): Promise<{ ok: boolean; error?: string }> {
    const formData = new FormData();
    formData.set('contactId', contactId);

    try {
      await anonymizeContactAction(formData);
      router.refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: actionError(error) };
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary border-red-300 text-red-700 hover:bg-red-100"
        onClick={() => setConfirmOpen(true)}
      >
        <UserX className="h-4 w-4" />
        Portal-Kontakt jetzt anonymisieren
      </button>

      {confirmOpen && (
        <ConfirmModal
          danger
          title="Portal-Kontakt anonymisieren"
          message={
            <>
              <p>
                Den Portal-Kontakt „{subjectName}“ wirklich anonymisieren? Stammdaten werden
                ersetzt, der Zugang wird gesperrt und offene Links werden ungültig.
              </p>
              <p className="mt-2 font-medium text-red-800">
                Dieser Teilschritt lässt sich nicht rückgängig machen und löscht nicht automatisch
                weitere Datenklassen oder aufbewahrungspflichtige Unterlagen.
              </p>
            </>
          }
          confirmLabel="Verbindlich anonymisieren"
          busyLabel="Anonymisiere…"
          onConfirm={anonymize}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}
