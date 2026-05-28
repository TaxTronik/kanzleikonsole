'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cancelAppointmentRequestAction } from './actions';

export function CancelRequestButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, start] = useTransition();

  function cancel() {
    if (!confirm('Terminanfrage zurücknehmen?')) return;
    start(async () => {
      const res = await cancelAppointmentRequestAction({ id });
      if (!res.ok) {
        alert(res.error ?? 'Abbrechen fehlgeschlagen.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={cancel}
      disabled={isPending}
      className="text-disabled hover:text-red-700 p-1 shrink-0"
      title="Anfrage zurücknehmen"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
