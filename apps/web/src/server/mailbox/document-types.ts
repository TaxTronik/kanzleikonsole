import type { TxClient } from '@taxtronik/db';

/** Zulässige Archivtypen für eine ausdrücklich bestätigte Mailbox-Zuordnung. */
export function loadMailboxDocumentTypesTx(tx: TxClient, tenantId: string) {
  return tx.documentType.findMany({
    where: {
      tenantId,
      active: true,
      tier: { not: 'GWG' },
      // Eigene Typen haben keinen Klassifikationsschlüssel; SQL NOT IN allein
      // würde diese zulässigen NULL-Zeilen aus der Auswahl ausschließen.
      OR: [
        { classificationKey: null },
        { classificationKey: { notIn: ['STAFF_PRIVATE', 'PERSONNEL'] } },
      ],
    },
    select: { id: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });
}
