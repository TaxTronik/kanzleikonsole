// =============================================================================
// Zustellstatus der Mandanten-Mails eines Vorgangs (Review-Befund F-08)
//
// Liest die mail_outbox-Aufträge in der Tenant-Transaktion der Seite (RLS) und
// fasst sie je Anlass zusammen. Die Seite zeigt damit statt eines bloßen
// „versendet" den tatsächlichen Stand: wartend, angenommen, ohne Empfänger,
// fehlgeschlagen oder unklar.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { MailOutboxResourceType } from '@taxtronik/mail/outbox';
import { summarizeMailDelivery, type MailDeliverySummary } from '@/lib/mail-delivery-status';

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
  const byResource = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byResource.get(row.resourceId) ?? [];
    list.push(row);
    byResource.set(row.resourceId, list);
  }
  for (const [resourceId, list] of byResource) {
    result.set(resourceId, summarizeMailDelivery(list));
  }
  return result;
}
