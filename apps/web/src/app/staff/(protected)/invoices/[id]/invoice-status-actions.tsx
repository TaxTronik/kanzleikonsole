'use client';

// =============================================================================
// Statuswechsel-Buttons einer Rechnung mit Bestätigungsdialog.
//
// „Als bezahlt markieren" und vor allem „Stornieren" sind bei einer GoBD-
// fixierten Nummerierung nicht triviale, teils unumkehrbare Schritte. Vorher
// waren es nackte Ein-Klick-Server-Action-Forms — ein Fehlklick storniert
// unwiderruflich. Jetzt läuft der Klick über ConfirmModal (App-Standard).
// =============================================================================

import { useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { markPaidAction, cancelInvoiceAction } from '../actions';

type Dialog = null | 'paid' | 'cancel';

export function InvoiceStatusActions({
  invoiceId,
  invoiceNumber,
  isPaid,
  showMarkPaid,
  showCancel,
}: {
  invoiceId: string;
  invoiceNumber: string;
  isPaid: boolean;
  showMarkPaid: boolean;
  showCancel: boolean;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);

  const run = async (
    action: (fd: FormData) => Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> => {
    const fd = new FormData();
    fd.set('invoiceId', invoiceId);
    try {
      await action(fd);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? 'Aktion fehlgeschlagen.' };
    }
  };

  return (
    <>
      {showMarkPaid && (
        <button type="button" onClick={() => setDialog('paid')} className="btn-primary">
          <CheckCircle2 className="h-4 w-4" />
          Als bezahlt markieren
        </button>
      )}
      {showCancel && (
        <button
          type="button"
          onClick={() => setDialog('cancel')}
          className="btn-secondary text-red-700 border-red-300 hover:bg-red-50"
        >
          <X className="h-4 w-4" />
          Stornieren
        </button>
      )}

      {dialog === 'paid' && (
        <ConfirmModal
          title="Als bezahlt markieren"
          message={`Rechnung ${invoiceNumber} als bezahlt markieren? Der Zahlungseingang wird mit dem heutigen Datum vermerkt.`}
          confirmLabel="Als bezahlt markieren"
          busyLabel="Markiere…"
          onConfirm={() => run(markPaidAction)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'cancel' && (
        <ConfirmModal
          danger
          title="Rechnung stornieren"
          message={
            `Rechnung ${invoiceNumber} wirklich stornieren? ` +
            `Bei bereits versendeten Rechnungen entsteht ein Korrekturbeleg mit eigener, ` +
            `lückenloser Nummer (§ 14c UStG). Der Vorgang ist nicht umkehrbar.` +
            (isPaid
              ? ' Diese Rechnung wurde bereits als BEZAHLT markiert — die Rückzahlung ist ' +
                'gesondert abzuwickeln (kein automatischer Zahlungsfluss); die abgerechneten ' +
                'Zeiten bleiben verbucht.'
              : '')
          }
          confirmLabel="Stornieren"
          busyLabel="Storniere…"
          onConfirm={() => run(cancelInvoiceAction)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
