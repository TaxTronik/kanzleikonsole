'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function ConfirmSubmitButton({
  children,
  message,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; message: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        {...props}
        type="button"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="gwg-review-confirm-title"
            aria-describedby="gwg-review-confirm-message"
            className="w-full max-w-md rounded-md border-2 border-red-600 bg-white p-5 shadow-2xl dark:bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-red-100 p-2 text-red-700 dark:bg-red-950 dark:text-red-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="gwg-review-confirm-title" className="text-base font-semibold text-red-700 dark:text-red-300">
                  GwG-Prüfung bestätigen
                </h2>
                <p id="gwg-review-confirm-message" className="mt-2 text-sm text-secondary">
                  {message}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2 border-t border-red-100 pt-4 dark:border-red-950">
              <button type="button" className="btn-secondary text-sm" onClick={() => setOpen(false)}>
                Abbrechen
              </button>
              <button type="submit" className="btn-primary !bg-red-600 text-sm hover:!bg-red-700">
                Geprüft bestätigen
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
