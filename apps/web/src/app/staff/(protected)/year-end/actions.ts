'use server';
import { z } from 'zod';
import { withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertModuleEnabled } from '@/server/settings/modules';
import { freezeFormSchema } from '@/server/forms/schema-snapshot';
import { evidenceService } from '@/server/container';
import { berlinWallClockToUtc } from '@/lib/fmt';
import { validWorkflowCalendarDate } from '@/server/workflows/interaction-policy';
import { returnCampaignSubmissionTx } from '@/server/workflows/year-end-return';

export async function returnCampaignSubmissionAction(data: FormData) {
  const parsed = z
    .object({
      entryId: z.uuid(),
      note: z.string().trim().min(10).max(2000),
      updatedAt: z.iso.datetime().transform((value) => new Date(value)),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success)
    return { ok: false, error: 'Vorgang und mandantensichtbare Rückfrage prüfen.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'forms');
      await returnCampaignSubmissionTx(tx, g, parsed.data);
    },
    {
      module: 'yearEndCampaigns',
      revalidate: ['/staff/year-end', '/staff/forms', '/portal/forms', '/portal/requests'],
    },
  );
}

export async function createCampaignAction(data: FormData) {
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(150),
      year: z.coerce.number().int().min(2000).max(2200),
      templateId: z.string().uuid(),
      due: z.string().refine(validWorkflowCalendarDate),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { ok: false, error: 'Name, Jahr, Vorlage und Zieltermin prüfen.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'forms');
      await tx.$queryRaw`SELECT id FROM form_template WHERE id=${parsed.data.templateId}::uuid FOR SHARE`;
      const template = await tx.formTemplate.findUnique({
        where: { id: parsed.data.templateId },
        include: { fields: { orderBy: { position: 'asc' } } },
      });
      if (!template?.active || !template.fields.length)
        throw new ActionError('Aktive Vorlage mit Feldern erforderlich.');
      const campaign = await tx.yearEndCampaign.create({
        data: {
          tenantId: g.tenantId,
          name: parsed.data.name,
          year: parsed.data.year,
          templateId: template.id,
          schemaSnapshot: freezeFormSchema(template) as object,
          dueAt: berlinWallClockToUtc(`${parsed.data.due}T23:59`)!,
          createdByStaff: g.staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'year_end.campaign.created',
        resourceType: 'year_end_campaign',
        resourceId: campaign.id,
        after: { year: campaign.year, fieldCount: template.fields.length },
      });
    },
    { module: 'yearEndCampaigns', requireAdmin: true, revalidate: '/staff/year-end' },
  );
}

export async function rolloutCampaignAction(data: FormData) {
  const parsed = z
    .object({
      campaignId: z.string().uuid(),
      clientIds: z.array(z.string().uuid()).min(1).max(200),
    })
    .safeParse({ campaignId: data.get('campaignId'), clientIds: data.getAll('clientId') });
  if (!parsed.success) return { ok: false, error: 'Kampagne und 1–200 Mandanten auswählen.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'forms');
      const campaign = await tx.yearEndCampaign.findUnique({
        where: { id: parsed.data.campaignId },
      });
      if (!campaign) throw new ActionError('Kampagne nicht gefunden.');
      await tx.$queryRaw`SELECT id FROM year_end_campaign WHERE id=${campaign.id}::uuid FOR UPDATE`;
      let created = 0;
      for (const clientId of [...new Set(parsed.data.clientIds)]) {
        await assertClientAccessTx(tx, g.session, clientId);
        const client = await tx.client.findFirst({
          where: { id: clientId, allowActive: true, mandateEndedAt: null },
          select: { id: true },
        });
        if (!client) throw new ActionError('Mandant ohne freigeschaltetes Portal.');
        if (
          await tx.yearEndCampaignEntry.findUnique({
            where: { campaignId_clientId: { campaignId: campaign.id, clientId } },
          })
        )
          continue;
        const submission = await tx.formSubmission.create({
          data: {
            tenantId: g.tenantId,
            clientId,
            templateId: campaign.templateId,
            schemaSnapshot: campaign.schemaSnapshot as object,
            name: `${campaign.name} ${campaign.year}`,
            createdByStaff: g.staffId,
          },
        });
        const request = await tx.request.create({
          data: {
            tenantId: g.tenantId,
            clientId,
            title: `${campaign.name} ${campaign.year}`,
            description:
              'Bitte bearbeiten Sie die Jahreswechsel-Checkliste und laden Sie die angeforderten Unterlagen hoch. Ihre Kanzlei prüft die eingereichten Angaben anschließend.',
            formSubmissionId: submission.id,
            dueAt: campaign.dueAt,
            createdByStaff: g.staffId,
          },
        });
        await tx.formSubmission.update({
          where: { id: submission.id },
          data: { requestId: request.id },
        });
        await tx.yearEndCampaignEntry.create({
          data: {
            tenantId: g.tenantId,
            campaignId: campaign.id,
            clientId,
            submissionId: submission.id,
            requestId: request.id,
          },
        });
        created++;
      }
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'year_end.campaign.rolled_out',
        resourceType: 'year_end_campaign',
        resourceId: campaign.id,
        after: { created },
      });
    },
    {
      module: 'yearEndCampaigns',
      requireAdmin: true,
      revalidate: '/staff/year-end',
      transactionIsolationLevel: 'Serializable',
    },
  );
}
