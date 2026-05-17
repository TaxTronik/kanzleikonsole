'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const InputSchema = z.object({
  requestId: z.string().uuid(),
  clientId: z.string().uuid(),
  approve: z.boolean(),
  decisionNote: z.string().max(500).nullable().optional(),
});

const ALLOWED_FIELDS = [
  'name', 'street', 'postalCode', 'city', 'countryIso', 'vatId', 'invoiceEmail',
] as const;
const GWG_FIELDS = new Set(['name', 'street', 'postalCode', 'city', 'countryIso', 'vatId']);

type ClientField = (typeof ALLOWED_FIELDS)[number];

export async function decideChangeRequestAction(
  input: z.infer<typeof InputSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { requestId, clientId, approve, decisionNote } = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const req = await tx.clientMasterChangeRequest.findUnique({
          where: { id: requestId },
        });
        if (!req) throw new Error('Anfrage nicht gefunden.');
        if (req.clientId !== clientId) throw new Error('Mandant stimmt nicht überein.');
        if (req.status !== 'PENDING') throw new Error('Anfrage wurde bereits entschieden.');

        const fields = (req.fields ?? {}) as Record<string, unknown>;
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
          const before = await tx.client.findUnique({
            where: { id: clientId },
            select: {
              name: true, street: true, postalCode: true,
              city: true, countryIso: true, vatId: true, invoiceEmail: true,
            },
          });
          if (!before) throw new Error('Mandant nicht gefunden.');

          await tx.client.update({
            where: { id: clientId },
            data: applicable as Prisma.ClientUpdateInput,
          });

          // GwG-relevante Änderung erkannt? VERIFIED → IN_REVIEW
          const gwgChanged = (Object.keys(applicable) as ClientField[]).some(
            (k) => GWG_FIELDS.has(k) && (before as Record<string, unknown>)[k] !== applicable[k],
          );
          let gwgReset = false;
          if (gwgChanged) {
            const updated = await tx.gwgCheck.updateMany({
              where: { clientId, status: 'VERIFIED' },
              data: { status: 'IN_REVIEW' },
            });
            gwgReset = updated.count > 0;
          }

          await tx.clientMasterChangeRequest.update({
            where: { id: requestId },
            data: {
              status: 'APPROVED',
              decidedAt: new Date(),
              decidedBy: staffId,
              decisionNote: decisionNote ?? null,
            },
          });

          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'client_master_change.approve',
            resourceType: 'client_master_change_request',
            resourceId: requestId,
            before,
            after: { ...applicable, _gwgReverificationTriggered: gwgReset },
          });
        } else {
          await tx.clientMasterChangeRequest.update({
            where: { id: requestId },
            data: {
              status: 'REJECTED',
              decidedAt: new Date(),
              decidedBy: staffId,
              decisionNote: decisionNote ?? null,
            },
          });
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
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  revalidatePath(`/staff/clients/${clientId}/change-requests`);
  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/edit`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
  revalidatePath('/portal/stammdaten');
  return { ok: true };
}
