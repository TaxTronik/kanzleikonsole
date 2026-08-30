'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cancelAppointmentRequestAction } from './actions';
import { confirmDialog, noticeDialog } from '@/components/ui/modal';

export function CancelRequestButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, start] = useTransition();

  async function cancel() {
    if (
      !(await confirmDialog('Terminanfrage zurücknehmen?', {
        title: 'Terminanfrage zurücknehmen',
        confirmLabel: 'Zurücknehmen',
        danger: true,
      }))
    )
      return;
    start(async () => {
      const res = await cancelAppointmentRequestAction({ id });
      if (!res.ok) {
        await noticeDialog(res.error ?? 'Abbrechen fehlgeschlagen.', {
          title: 'Terminanfrage zurücknehmen',
        });
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
