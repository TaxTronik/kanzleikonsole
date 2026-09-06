import type { WorkBasketExtension, WorkBasketItem } from '@/server/work/basket';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf),
// ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001.

export function portalInboxWorkExtension(tenantId: string): WorkBasketExtension {
  return {
    kind: 'portal-inbox',
    slots: ['mine', 'team'],
    async load(context): Promise<WorkBasketItem[]> {
      const rows = await context.tx.portalInboxThread.findMany({
        where: {
          tenantId,
          status: 'OPEN',
          attention: 'STAFF',
          ...(context.slot === 'mine'
            ? { assignedStaffId: context.staffId }
            : { assignedStaffId: null }),
          ...(context.deniedClientIds?.length
            ? { clientId: { notIn: context.deniedClientIds } }
            : {}),
          client: {
            tenantId,
            allowActive: true,
            anonymizedAt: null,
            mandateEndedAt: null,
          },
        },
        orderBy: [{ lastMessageAt: 'asc' }, { id: 'asc' }],
        take: context.limit,
        select: {
          id: true,
          subject: true,
          lastMessageAt: true,
          client: { select: { name: true } },
          messages: {
            select: {
              attachments: {
                where: { decision: 'PENDING_REVIEW' },
                select: { id: true },
              },
            },
          },
        },
      });
      return rows.map((row) => {
        const pendingAttachments = row.messages.reduce(
          (sum, message) => sum + message.attachments.length,
          0,
        );
        return {
          key: `portal-inbox:${row.id}`,
          kind: 'portal-inbox',
          slot: context.slot,
          title: row.subject,
          context:
            row.client.name +
            (pendingAttachments
              ? ` · ${pendingAttachments} Anlage${pendingAttachments === 1 ? '' : 'n'} prüfen`
              : ''),
          href: `/staff/inbox/${row.id}`,
          bucket: 'undated',
          sortAt: row.lastMessageAt,
          occurredAt: row.lastMessageAt,
          sourceId: row.id,
        };
      });
    },
  };
}
