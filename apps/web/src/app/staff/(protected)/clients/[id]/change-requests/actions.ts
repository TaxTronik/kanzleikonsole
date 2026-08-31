'use server';

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { lockGwgCheckLifecycleTx, requireGwgReverificationTx } from '@/server/gwg/reverification';
import { TaxChangeRequestSchema } from '@/server/tax-master-data/schema';
import { saveTaxMasterDataTx } from '@/server/tax-master-data/service';

const InputSchema = z.object({
  requestId: z.string().uuid(),
  clientId: z.string().uuid(),
  approve: z.boolean(),
  decisionNote: z.string().max(500).nullable().optional(),
});

const ALLOWED_FIELDS = [
  'name',
  'street',
  'postalCode',
  'city',
  'countryIso',
  'vatId',
  'invoiceEmail',
] as const;
const GWG_FIELDS = new Set(['name', 'street', 'postalCode', 'city', 'countryIso']);

type ClientField = (typeof ALLOWED_FIELDS)[number];

export async function decideChangeRequestAction(
  input: z.infer<typeof InputSchema>,
): Promise<ActionResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { requestId, clientId, approve, decisionNote } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const req = await tx.clientMasterChangeRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.clientId !== clientId) throw new ActionError('Mandant stimmt nicht überein.');
      await assertClientAccessTx(tx, session, req.clientId);
      if (req.status !== 'PENDING') throw new ActionError('Anfrage wurde bereits entschieden.');

      // TOCTOU-Schutz: Entscheidung zuerst atomar claimen, BEVOR Stammdaten
      // übernommen werden. Zwei parallele Entscheidungen (approve ‖ reject)
      // lesen sonst beide PENDING — die Daten würden übernommen, obwohl final
      // REJECTED gespeichert wird (inkl. doppeltem GwG-Reset/Audit).
      const decisionClaim = await tx.clientMasterChangeRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedAt: new Date(),
          decidedBy: staffId,
          decisionNote: decisionNote ?? null,
        },
      });
      if (decisionClaim.count === 0) throw new ActionError('Anfrage wurde bereits entschieden.');
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'client_master_change_request', resourceId: requestId }],
      });

      const fields = (req.fields ?? {}) as Record<string, unknown>;
      if (approve && 'taxData' in fields) {
        const taxRequest = TaxChangeRequestSchema.safeParse(fields.taxData);
        if (!taxRequest.success || Object.keys(fields).length !== 1)
          throw new ActionError('Ungültiger Steuerdatenvorschlag.');
        await saveTaxMasterDataTx(tx, {
          tenantId,
          clientId,
          staffId,
          expectedRevision: taxRequest.data.expectedRevision,
          draft: taxRequest.data.draft,
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_master_change.approve',
          resourceType: 'client_master_change_request',
          resourceId: requestId,
          after: { fieldGroup: 'taxData', _gwgReverificationTriggered: false },
        });
        return;
      }
      const applicable: Partial<Record<ClientField, string | null>> = {};
      for (const k of ALLOWED_FIELDS) {
        if (k in fields) {
          const v = fields[k];
          if (typeof v === 'string') {
            const t = v.trim();
            applicable[k] = t === '' ? null : t;
          }
        }
      }

      if (approve) {
        await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
        const before = await tx.client.findUnique({
          where: { id: clientId },
          select: {
            name: true,
            street: true,
            postalCode: true,
            city: true,
            countryIso: true,
            vatId: true,
            invoiceEmail: true,
          },
        });
        if (!before) throw new ActionError('Mandant nicht gefunden.');

        await tx.client.update({
          where: { id: clientId },
          data: applicable as Prisma.ClientUpdateInput,
        });

        // GwG-relevante Änderung erkannt? VERIFIED → IN_REVIEW
        const gwgChanged = (Object.keys(applicable) as ClientField[]).some(
          (k) => GWG_FIELDS.has(k) && (before as Record<string, unknown>)[k] !== applicable[k],
        );
        let gwgReset = false;
        let gwgReviewCheckId: string | null = null;
        let gwgInvalidatedIdentityDocuments = 0;
        if (gwgChanged) {
          const reset = await requireGwgReverificationTx(tx, { tenantId, clientId });
          gwgReset = reset.reviewCheckId !== null;
          gwgReviewCheckId = reset.reviewCheckId;
          gwgInvalidatedIdentityDocuments = reset.invalidatedIdentityDocuments;
        }

        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_master_change.approve',
          resourceType: 'client_master_change_request',
          resourceId: requestId,
          before,
          after: {
            ...applicable,
            _gwgReverificationTriggered: gwgReset,
            _gwgReviewCheckId: gwgReviewCheckId,
            _gwgInvalidatedIdentityDocuments: gwgInvalidatedIdentityDocuments,
          },
        });
      } else {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_master_change.reject',
          resourceType: 'client_master_change_request',
          resourceId: requestId,
          after: { decisionNote: decisionNote ?? null },
        });
      }
    },
    {
      revalidate: [
        `/staff/clients/${clientId}/change-requests`,
        `/staff/clients/${clientId}`,
        `/staff/clients/${clientId}/edit`,
        `/staff/clients/${clientId}/elster`,
        `/staff/clients/${clientId}/gwg`,
        '/portal/stammdaten',
      ],
    },
  );
}
