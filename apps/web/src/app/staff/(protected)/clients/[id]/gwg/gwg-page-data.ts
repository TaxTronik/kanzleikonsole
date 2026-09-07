import { withTenantContext } from '@taxtronik/db';
import { canStaffReviewGwgTx } from '@/server/gwg/professional-review';
import { findCleanGwgEvidenceDocumentsTx } from '@/server/gwg/evidence-documents';

export async function loadGwgPageData({
  tenantId,
  clientId,
  staffId,
}: {
  tenantId: string;
  clientId: string;
  staffId: string;
}) {
  return await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
    const client = await tx.client.findUnique({ where: { id: clientId } });
    if (!client) return null;
    const [check, clientDocuments, invites, contacts, canVerify, checkHistory] = await Promise.all([
      tx.gwgCheck.findFirst({
        where: { clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          beneficialOwners: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          idDocuments: {
            orderBy: { createdAt: 'asc' },
            include: {
              document: {
                select: {
                  id: true,
                  title: true,
                  createdAt: true,
                  tenantId: true,
                  clientId: true,
                  classification: true,
                  deletedAt: true,
                  gwgDestructionRequestedAt: true,
                  gwgDestroyedAt: true,
                  versions: {
                    orderBy: { versionNo: 'desc' },
                    take: 1,
                    select: { scanStatus: true, scanCompletedAt: true },
                  },
                },
              },
            },
          },
        },
      }),
      findCleanGwgEvidenceDocumentsTx(tx, {
        tenantId,
        clientId,
        // Kleine Startmenge für schnelle GwG-Seite; der Dateimanager
        // durchsucht ältere Belege bei Eingabe serverseitig vollständig.
        limit: 50,
      }),
      tx.gwgOnboardingInvite.findMany({
        where: { clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
      }),
      tx.clientContact.findMany({
        where: { clientId, active: true },
        select: { id: true, fullName: true, email: true, role: true },
        orderBy: { fullName: 'asc' },
      }),
      canStaffReviewGwgTx(tx, { tenantId, clientId, staffId }),
      tx.gwgCheck.findMany({
        where: { clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          status: true,
          changeScope: true,
          predecessorCheckId: true,
          createdAt: true,
          reviewSubmittedAt: true,
          verifiedAt: true,
          destroyedAt: true,
        },
      }),
    ]);
    return {
      tenantId,
      client,
      check,
      clientDocuments,
      invites,
      contacts,
      canVerify,
      checkHistory,
    };
  });
}

export type GwgPageData = NonNullable<Awaited<ReturnType<typeof loadGwgPageData>>>;
export type GwgPageCheck = NonNullable<GwgPageData['check']>;
