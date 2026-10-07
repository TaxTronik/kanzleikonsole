// =============================================================================
// Zustellstatus der Mandanten-Mails eines Vorgangs (Review-Befund F-08)
//
// Liest die mail_outbox-Aufträge in der Tenant-Transaktion der Seite (RLS) und
// fasst sie je Anlass zusammen. Die Seite zeigt damit statt eines bloßen
// „versendet" den tatsächlichen Stand: wartend, angenommen, ohne Empfänger,
// fehlgeschlagen, unklar oder verworfen. C4: Fehlgeschlagene und unklare
// Aufträge mit erhaltenem Inhalt bieten „Erneut senden" an; ob Inhalt erhalten
// ist, prüft eine eigene Abfrage, ohne Inhalt oder Empfänger zu laden.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { MailOutboxResourceType } from '@taxtronik/mail/outbox';
import { summarizeMailDelivery, type MailDeliverySummary } from '@/lib/mail-delivery-status';

async function resendableIdsTx(tx: TxClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx.mailOutbox.findMany({
    where: {
      id: { in: [...ids] },
      status: { in: ['FAILED', 'UNKNOWN'] },
      NOT: { payload: { equals: {} } },
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

export async function loadMailDeliveryTx(
  tx: TxClient,
  input: { resourceType: MailOutboxResourceType; resourceIds: readonly string[] },
): Promise<Map<string, MailDeliverySummary[]>> {
  const result = new Map<string, MailDeliverySummary[]>();
  if (input.resourceIds.length === 0) return result;
  const rows = await tx.mailOutbox.findMany({
    where: { resourceType: input.resourceType, resourceId: { in: [...input.resourceIds] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      resourceId: true,
      purpose: true,
      kind: true,
      status: true,
      recipientsAttempted: true,
      recipientsAccepted: true,
      createdAt: true,
      // Nur für verworfene Aufträge angezeigt (Begründung ohne Empfängerdaten).
      lastError: true,
    },
  });
  const resendable = await resendableIdsTx(
    tx,
    rows.filter((row) => row.status === 'FAILED' || row.status === 'UNKNOWN').map((row) => row.id),
  );
  const byResource = new Map<string, Array<(typeof rows)[number] & { resendable: boolean }>>();
  for (const row of rows) {
    const list = byResource.get(row.resourceId) ?? [];
    list.push({ ...row, resendable: resendable.has(row.id) });
    byResource.set(row.resourceId, list);
  }
  for (const [resourceId, list] of byResource) {
    result.set(
      resourceId,
      summarizeMailDelivery(list, { resourceType: input.resourceType, resourceId }),
    );
  }
  return result;
}
