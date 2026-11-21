'use client';

import { useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/modal';

export function MoreEntries({
  count,
  dateLabel,
  children,
}: {
  count: number;
  dateLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count <= 0) return null;
  const title = `Weitere Einträge am ${dateLabel}`;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`+${count} weitere Einträge am ${dateLabel}`}
        className="text-left text-[11px] font-medium text-brand-700 hover:underline"
        onClick={() => setOpen(true)}
      >
        +{count} weitere
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <h2 className="pr-8 text-base font-semibold">{title}</h2>
          <div className="mt-4 grid gap-2 [&_.cal-pill]:whitespace-normal [&_.cal-pill]:break-words [&_.cal-pill]:p-2">
            {children}
          </div>
        </Modal>
      )}
    </>
  );
}
