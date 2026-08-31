// Run after the SQL migration and before reopening application writers:
// pnpm --filter @taxtronik/web exec tsx --env-file-if-exists=../../.env src/server/gwg-onboarding/migrate-invite-v2-audit.ts --apply
// Without --apply this only reports pending marker counts. No mail is sent.
import { z } from 'zod';
import { prismaOwner } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';

const KEY = 'migration.gwg_invite_v2';
const MarkerSchema = z.object({
  occurredAt: z.string(),
  invites: z.array(z.object({ id: z.string().uuid(), clientId: z.string().uuid() })),
  auditedAt: z.string().optional(),
});

async function main() {
  const markers = await prismaOwner.tenantSetting.findMany({ where: { key: KEY } });
  let pending = 0;
  for (const marker of markers) {
    const parsed = MarkerSchema.parse(marker.value);
    if (parsed.auditedAt) continue;
    pending += parsed.invites.length;
    if (!process.argv.includes('--apply')) continue;
    await prismaOwner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT tenant_id FROM tenant_setting WHERE tenant_id = ${marker.tenantId}::uuid AND key = ${KEY} FOR UPDATE`;
        const current = await tx.tenantSetting.findUniqueOrThrow({
          where: { tenantId_key: { tenantId: marker.tenantId, key: KEY } },
        });
        const facts = MarkerSchema.parse(current.value);
        if (facts.auditedAt) return;
        for (const invite of facts.invites) {
          await evidenceService.record(tx, {
            tenantId: marker.tenantId,
            actorType: 'SYSTEM',
            actorId: null,
            action: 'gwg.invite.migration.cancel',
            resourceType: 'gwg_onboarding_invite',
            resourceId: invite.id,
            after: {
              clientId: invite.clientId,
              reason: 'tax_master_data_v2',
              migrationOccurredAt: facts.occurredAt,
              auditRecordedAfterMigration: true,
            },
          });
        }
        await tx.tenantSetting.update({
          where: { tenantId_key: { tenantId: marker.tenantId, key: KEY } },
          data: { value: { ...facts, auditedAt: new Date().toISOString() } },
        });
      },
      { timeout: 120_000 },
    );
  }
  process.stdout.write(
    `${process.argv.includes('--apply') ? 'Audited' : 'Pending'} invitation cancellations: ${pending}\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Migration audit failed'}\n`);
    process.exitCode = 1;
  })
  .finally(() => prismaOwner.$disconnect());
