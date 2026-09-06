// Fachkatalog: FORM-SCHEMA-SNAPSHOT-001, YEAR-END-CAMPAIGN-001, CLIENT-FEEDBACK-001, TAX-NOTICE-DECISION-001.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';
const run =
  process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL'] ? describe : describe.skip;
run('workflow expansion against the real app role', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
  });
  let tenantId: string,
    contactId: string,
    otherContactId: string,
    staffId: string,
    templateId: string,
    submissionId: string,
    interactionId: string;
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenant = await owner.tenant.create({
      data: { slug: `workflow-expansion-${suffix}`, name: 'Workflow Test' },
    });
    tenantId = tenant.id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `staff-${suffix}@example.test`,
          fullName: 'Staff',
          passwordHash: 'x',
        },
      })
    ).id;
    const client = await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Test client' },
    });
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: client.id,
      verifiedBy: staffId,
      registerNumber: `HRB-${suffix}`,
    });
    await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
    contactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: client.id,
          email: `one-${suffix}@example.test`,
          fullName: 'One',
        },
      })
    ).id;
    otherContactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: client.id,
          email: `two-${suffix}@example.test`,
          fullName: 'Two',
        },
      })
    ).id;
    const template = await owner.formTemplate.create({
      data: {
        tenantId,
        name: 'Original template',
        createdByStaff: staffId,
        fields: { create: { position: 0, key: 'original', label: 'Original field', type: 'TEXT' } },
      },
    });
    templateId = template.id;
    submissionId = (
      await owner.formSubmission.create({
        data: { tenantId, clientId: client.id, templateId, name: 'Test', createdByStaff: staffId },
      })
    ).id;
    const workflow = await owner.workflowInstance.create({
      data: {
        tenantId,
        clientId: client.id,
        name: 'Milestone',
        status: 'COMPLETED',
        completedAt: new Date(),
        startedByStaff: staffId,
      },
    });
    const request = await owner.request.create({
      data: {
        tenantId,
        clientId: client.id,
        title: 'Feedback',
        description: 'Voluntary',
        createdByStaff: staffId,
      },
    });
    interactionId = (
      await owner.clientInteraction.create({
        data: {
          tenantId,
          clientId: client.id,
          contactId,
          kind: 'FEEDBACK',
          sourceId: workflow.id,
          requestId: request.id,
          snapshot: { version: 1, title: 'Milestone' },
          expiresAt: new Date(Date.now() + 86400000),
          createdByStaff: staffId,
        },
      })
    ).id;
  });
  afterAll(async () => {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  function asContact<T>(id: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),set_config('app.current_actor_id',${id},true),set_config('app.current_actor_type','CLIENT_CONTACT',true)`;
      return fn(tx);
    });
  }
  it('snapshots a new submission without fabricating a migration history', async () => {
    await owner.formField.updateMany({ where: { templateId }, data: { label: 'Changed later' } });
    const sub = await owner.formSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(JSON.stringify(sub.schemaSnapshot)).toContain('Original field');
    expect(JSON.stringify(sub.schemaSnapshot)).not.toContain('Changed later');
    await expect(
      owner.formSubmission.update({
        where: { id: submissionId },
        data: { schemaSnapshot: { version: 1, fields: [] } },
      }),
    ).rejects.toThrow();
  });
  it('hides a designated invitation from another contact of the same client', async () => {
    expect(
      await asContact(otherContactId, (tx) =>
        tx.clientInteraction.findMany({ where: { id: interactionId } }),
      ),
    ).toEqual([]);
    expect(
      (
        await asContact(otherContactId, (tx) =>
          tx.clientInteraction.updateMany({
            where: { id: interactionId },
            data: { status: 'RESPONDED', response: '1', respondedAt: new Date() },
          }),
        )
      ).count,
    ).toBe(0);
  });
  it('YEAR-END-CAMPAIGN-001 preserves an older campaign schema and prohibits duplicate client allocation', async () => {
    const source = await owner.formSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    const campaign = await owner.yearEndCampaign.create({
      data: {
        tenantId,
        name: 'Frozen year end',
        year: 2026,
        templateId,
        schemaSnapshot: source.schemaSnapshot as Prisma.InputJsonValue,
        dueAt: new Date('2026-12-31'),
        createdByStaff: staffId,
      },
    });
    const allocation = await owner.$transaction(async (tx) => {
      const submission = await tx.formSubmission.create({
        data: {
          tenantId,
          clientId: source.clientId,
          templateId,
          name: 'Frozen campaign copy',
          schemaSnapshot: campaign.schemaSnapshot as Prisma.InputJsonValue,
          createdByStaff: staffId,
        },
      });
      const request = await tx.request.create({
        data: {
          tenantId,
          clientId: source.clientId,
          title: 'Frozen year end',
          description: 'Campaign test',
          formSubmissionId: submission.id,
          createdByStaff: staffId,
        },
      });
      await tx.formSubmission.update({
        where: { id: submission.id },
        data: { requestId: request.id },
      });
      const entry = await tx.yearEndCampaignEntry.create({
        data: {
          tenantId,
          clientId: source.clientId,
          campaignId: campaign.id,
          submissionId: submission.id,
          requestId: request.id,
        },
      });
      return { entry, submission };
    });
    expect(JSON.stringify(allocation.submission.schemaSnapshot)).toContain('Original field');
    expect(JSON.stringify(allocation.submission.schemaSnapshot)).not.toContain('Changed later');
    await expect(
      owner.yearEndCampaign.update({
        where: { id: campaign.id },
        data: { schemaSnapshot: { version: 1, fields: [] } },
      }),
    ).rejects.toThrow();
    await expect(
      owner.yearEndCampaignEntry.create({
        data: {
          tenantId,
          clientId: source.clientId,
          campaignId: campaign.id,
          submissionId: allocation.entry.submissionId,
          requestId: allocation.entry.requestId,
        },
      }),
    ).rejects.toThrow();
    expect(await asContact(contactId, (tx) => tx.yearEndCampaign.findMany())).toEqual([]);
  });
  it('allows one designated response, but never revision rewriting', async () => {
    await asContact(contactId, (tx) =>
      tx.clientInteraction.update({
        where: { id: interactionId },
        data: { status: 'RESPONDED', response: '2', respondedAt: new Date() },
      }),
    );
    await expect(
      asContact(contactId, (tx) =>
        tx.clientInteraction.update({ where: { id: interactionId }, data: { response: '5' } }),
      ),
    ).rejects.toThrow();
    await expect(
      asContact(contactId, (tx) =>
        tx.clientInteraction.update({
          where: { id: interactionId },
          data: { snapshot: { version: 1, title: 'Changed' } },
        }),
      ),
    ).rejects.toThrow();
  });
  it('YEAR-END-CAMPAIGN-001 freezes old answers, submission time and exact file versions before correction', async () => {
    const base = await owner.formSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    await owner.formField.create({
      data: {
        templateId,
        position: 2,
        key: 'file',
        label: 'Source',
        type: 'FILE',
        required: false,
      },
    });
    const sub = await owner.formSubmission.create({
      data: {
        tenantId,
        templateId,
        clientId: base.clientId,
        name: 'Revision source',
        createdByStaff: staffId,
      },
    });
    const versionTime = new Date(Date.now() - 2000);
    const submittedAt = new Date();
    const document = await owner.document.create({
      data: {
        tenantId,
        clientId: base.clientId,
        title: 'original.pdf',
        classification: 'GENERAL',
        mimeType: 'application/pdf',
        formSubmissionId: sub.id,
        formFieldKey: 'file',
        sharedWithClientAt: new Date(),
        versions: {
          create: {
            versionNo: 1,
            storageBucket: 'test',
            storageKey: 'form-original',
            storageVersionId: 'original-v1',
            sha256: Buffer.alloc(32, 7),
            sizeBytes: 10n,
            scanStatus: 'CLEAN',
            createdById: staffId,
            createdAt: versionTime,
          },
        },
      },
      include: { versions: true },
    });
    const answers = {
      original: 'Original submitted answer',
      file: { documentId: document.id, fileName: 'original.pdf' },
    };
    await owner.formSubmission.update({
      where: { id: sub.id },
      data: { answers, status: 'SUBMITTED', submittedAt, submittedByContact: contactId },
    });
    await owner.documentVersion.create({
      data: {
        documentId: document.id,
        versionNo: 2,
        storageBucket: 'test',
        storageKey: 'form-later',
        storageVersionId: 'later-v2',
        sha256: Buffer.alloc(32, 8),
        sizeBytes: 20n,
        scanStatus: 'CLEAN',
        createdById: staffId,
        createdAt: new Date(submittedAt.getTime() + 1000),
      },
    });
    const revision = await owner.formSubmissionRevision.create({
      data: {
        tenantId,
        submissionId: sub.id,
        sequence: 1,
        schemaSnapshot: sub.schemaSnapshot as Prisma.InputJsonValue,
        answers,
        submittedAt,
        submittedByContact: contactId,
        capturedByStaff: staffId,
        files: {
          create: {
            fieldKey: 'file',
            documentVersionId: document.versions[0]!.id,
            sha256: Buffer.alloc(32, 7).toString('hex'),
          },
        },
      },
    });
    await owner.formSubmission.update({
      where: { id: sub.id },
      data: { status: 'DRAFT', answers: { original: 'Corrected draft' } },
    });
    const old = await asContact(contactId, (tx) =>
      tx.formSubmissionRevision.findUnique({
        where: { id: revision.id },
        include: { files: true },
      }),
    );
    expect(old?.answers).toEqual(answers);
    expect(old?.submittedAt).toEqual(submittedAt);
    expect(old?.files[0]?.documentVersionId).toBe(document.versions[0]!.id);
    await expect(
      owner.formSubmissionRevision.update({
        where: { id: revision.id },
        data: { answers: { original: 'Overwritten' } },
      }),
    ).rejects.toThrow();
    await expect(
      owner.documentVersion.delete({ where: { id: document.versions[0]!.id } }),
    ).rejects.toThrow();
    await expect(
      owner.documentVersion.update({
        where: { id: document.versions[0]!.id },
        data: { storageKey: 'retagged-source', storageVersionId: 'replacement' },
      }),
    ).rejects.toThrow('Submitted form source identity is immutable');
    await owner.documentVersion.update({
      where: { id: document.versions[0]!.id },
      data: { scanStatus: 'INFECTED' },
    });
    expect(
      (await owner.documentVersion.findUniqueOrThrow({ where: { id: document.versions[0]!.id } }))
        .scanStatus,
    ).toBe('INFECTED');
    await expect(
      asContact(contactId, (tx) =>
        tx.formSubmissionRevision.delete({ where: { id: revision.id } }),
      ),
    ).rejects.toThrow();
  });
  it('TAX-NOTICE-DECISION-001 binds the current notice and shared file version without completing legal control', async () => {
    const clientId = (await owner.clientContact.findUniqueOrThrow({ where: { id: contactId } }))
      .clientId;
    const makeNotice = async (label: string) => {
      const document = await owner.document.create({
        data: {
          tenantId,
          clientId,
          title: label,
          classification: 'GENERAL',
          mimeType: 'application/pdf',
          sharedWithClientAt: new Date(),
          sharedByStaff: staffId,
          versions: {
            create: {
              versionNo: 1,
              storageBucket: 'test',
              storageKey: 'notice/' + label,
              storageVersionId: 'v1',
              sha256: Buffer.alloc(32, 1),
              sizeBytes: 10n,
              scanStatus: 'CLEAN',
              createdById: staffId,
            },
          },
        },
        include: { versions: true },
      });
      const notice = await owner.taxNotice.create({
        data: {
          tenantId,
          clientId,
          kind: 'EST',
          period: label,
          noticeDate: new Date('2026-08-01'),
          status: 'GEPRUEFT',
          reviewedAt: new Date(),
          reviewedBy: staffId,
          reviewNotes: 'Synthetic reviewed notice fixture',
          documentId: document.id,
          createdByStaff: staffId,
        },
      });
      const request = await owner.request.create({
        data: {
          tenantId,
          clientId,
          title: label,
          description: 'Personal notice response',
          createdByStaff: staffId,
        },
      });
      const interaction = await owner.clientInteraction.create({
        data: {
          tenantId,
          clientId,
          contactId,
          kind: 'NOTICE',
          sourceId: notice.id,
          requestId: request.id,
          snapshot: {
            version: 1,
            title: label,
            explanation: 'Reviewed synthetic fixture',
            noticeUpdatedAt: notice.updatedAt.toISOString(),
            documentId: document.id,
            documentVersionId: document.versions[0]!.id,
            documentSha256: Buffer.alloc(32, 1).toString('hex'),
            assessedAmount: null,
            appealDeadline: '2026-12-01',
          },
          expiresAt: new Date(Date.now() + 86400000),
          createdByStaff: staffId,
        },
      });
      return { document, notice, request, interaction };
    };
    const respond = (id: string) =>
      asContact(contactId, (tx) =>
        tx.clientInteraction.update({
          where: { id },
          data: { status: 'RESPONDED', response: 'APPEAL_REQUESTED', respondedAt: new Date() },
        }),
      );
    const valid = await makeNotice('valid-notice');
    await respond(valid.interaction.id);
    expect(await owner.taxNotice.findUnique({ where: { id: valid.notice.id } })).toMatchObject({
      status: 'GEPRUEFT',
      appealFiledAt: null,
      legalFinalAt: null,
      appealDeadline: valid.notice.appealDeadline,
    });
    const closed = await makeNotice('closed-request');
    await owner.request.update({ where: { id: closed.request.id }, data: { status: 'CLOSED' } });
    await expect(respond(closed.interaction.id)).rejects.toThrow();
    const changed = await makeNotice('changed-source');
    await owner.taxNotice.update({
      where: { id: changed.notice.id },
      data: {
        updatedAt: new Date(changed.notice.updatedAt.getTime() + 1000),
        reviewNotes: 'Changed source stand',
      },
    });
    await expect(respond(changed.interaction.id)).rejects.toThrow();
    const replaced = await makeNotice('replaced-document');
    await owner.documentVersion.create({
      data: {
        documentId: replaced.document.id,
        versionNo: 2,
        storageBucket: 'test',
        storageKey: 'notice/replaced-v2',
        storageVersionId: 'v2',
        sha256: Buffer.alloc(32, 2),
        sizeBytes: 10n,
        scanStatus: 'CLEAN',
        createdById: staffId,
      },
    });
    await expect(respond(replaced.interaction.id)).rejects.toThrow();
  });
});
