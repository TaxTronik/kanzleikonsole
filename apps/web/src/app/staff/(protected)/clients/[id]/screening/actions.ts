'use server';
import { z } from 'zod';
import { withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { bindScreeningSubjectTx } from '@/server/screening/gwg-gate';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { createEuRun } from '@/server/screening/service';
import { evidenceService } from '@/server/container';
import { screeningJson } from '@taxtronik/tax/screening/persistence';
import { validateScreeningSubject } from '@taxtronik/tax';
const uuid = z.uuid();
const subjectSchema = z.object({
  name: z.string().trim().min(2).max(250),
  role: z.string().trim().min(1).max(160),
  birthDate: z.string().max(10).optional(),
  targetKey: z.string().max(100).optional(),
  contextHash: z.string().max(64).optional(),
});
const reviewSchema = z.object({
  note: z.string().trim().min(10).max(4000),
  sources: z
    .array(
      z
        .url()
        .max(2000)
        .refine((u) => /^https?:\/\//.test(u), 'Nur http/https Quellen.'),
    )
    .min(1)
    .max(20),
  outcome: z.enum(['UNRESOLVED', 'FALSE_POSITIVE', 'CONFIRMED', 'PEP_FOUND', 'PEP_NOT_FOUND']),
});
export async function runEuScreeningAction(clientId: string, raw: unknown) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(tx, g.session, uuid.parse(clientId));
      const parsed = subjectSchema.safeParse(raw);
      if (!parsed.success) throw new ActionError('Name, Rolle oder Geburtsdatum unvollständig.');
      const run = await createEuRun(tx, g.tenantId, g.staffId, clientId, parsed.data);
      return { runId: run.id };
    },
    { module: 'sanctionsScreening', revalidate: `/staff/clients/${clientId}/screening` },
  );
}
export async function recordPepResearchAction(
  clientId: string,
  rawSubject: unknown,
  rawReview: unknown,
) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(tx, g.session, uuid.parse(clientId));
      const parsed = subjectSchema.safeParse(rawSubject),
        review = reviewSchema.safeParse(rawReview);
      if (
        !parsed.success ||
        !review.success ||
        !['UNRESOLVED', 'PEP_FOUND', 'PEP_NOT_FOUND'].includes(review.data.outcome)
      )
        throw new ActionError(
          'PEP-Recherche benötigt Person, Ergebnis, Begründung und mindestens eine Quellen-URL.',
        );
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: g.tenantId, anonymizedAt: null, mandateEndedAt: null },
        select: { id: true },
      });
      if (!client) throw new ActionError('Mandat ist beendet oder nicht verfügbar.');
      let subject;
      try {
        subject = validateScreeningSubject(parsed.data);
      } catch {
        throw new ActionError('Personendaten ungültig.');
      }
      const bound = await bindScreeningSubjectTx(tx, g.tenantId, clientId, {
        ...subject,
        targetKey: parsed.data.targetKey,
        contextHash: parsed.data.contextHash,
      });
      const run = await tx.screeningRun.create({
        data: {
          tenantId: g.tenantId,
          clientId,
          kind: 'PEP',
          subject: screeningJson(bound),
          result: {
            method: 'MANUAL_RESEARCH',
            limitation:
              'Dokumentierte Einzelrecherche; keine vollständige PEP-Datenbank und keine GwG-Freigabe.',
          },
          createdBy: g.staffId,
        },
      });
      await tx.screeningReview.create({
        data: {
          tenantId: g.tenantId,
          clientId,
          runId: run.id,
          ...review.data,
          sources: screeningJson(review.data.sources),
          createdBy: g.staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'screening.pep.document',
        resourceType: 'screening_run',
        resourceId: run.id,
        after: { clientId, outcome: review.data.outcome },
      });
      return { runId: run.id };
    },
    { module: 'sanctionsScreening', revalidate: `/staff/clients/${clientId}/screening` },
  );
}
export async function reviewScreeningAction(clientId: string, runId: string, raw: unknown) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(tx, g.session, uuid.parse(clientId));
      await lockGwgCheckLifecycleTx(tx, { tenantId: g.tenantId, clientId });
      const review = reviewSchema.safeParse(raw);
      if (!review.success)
        throw new ActionError('Ergebnis, Begründung (mind. 10 Zeichen) und Quellen-URL fehlen.');
      const run = await tx.screeningRun.findFirst({
        where: { id: uuid.parse(runId), tenantId: g.tenantId, clientId },
      });
      if (!run) throw new ActionError('Prüflauf nicht gefunden.');
      const allowed =
        run.kind === 'PEP'
          ? ['UNRESOLVED', 'PEP_FOUND', 'PEP_NOT_FOUND']
          : ['UNRESOLVED', 'FALSE_POSITIVE', 'CONFIRMED'];
      if (!allowed.includes(review.data.outcome))
        throw new ActionError('Ergebnis passt nicht zur Rechercheart.');
      const saved = await tx.screeningReview.create({
        data: {
          tenantId: g.tenantId,
          clientId,
          runId,
          ...review.data,
          sources: screeningJson(review.data.sources),
          createdBy: g.staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'screening.review.append',
        resourceType: 'screening_run',
        resourceId: runId,
        after: { clientId, reviewId: saved.id, outcome: review.data.outcome },
      });
    },
    { module: 'sanctionsScreening', revalidate: `/staff/clients/${clientId}/screening` },
  );
}
