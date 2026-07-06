'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { writePrivacyConfig, type PrivacyConfig } from '@/server/privacy/notice';

const Schema = z.object({
  responsibleBody: z.string().max(2000).default(''),
  dpoContact: z.string().max(1000).default(''),
  supervisoryAuthority: z.string().max(1000).default(''),
  privacyContact: z.string().max(1000).default(''),
  drittlandServices: z.string().max(2000).default(''),
});

export async function savePrivacyConfigAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Kanzlei-weite Datenschutzangaben → nur ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = Schema.safeParse({
    responsibleBody: formData.get('responsibleBody') ?? '',
    dpoContact: formData.get('dpoContact') ?? '',
    supervisoryAuthority: formData.get('supervisoryAuthority') ?? '',
    privacyContact: formData.get('privacyContact') ?? '',
    drittlandServices: formData.get('drittlandServices') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const cfg: PrivacyConfig = {
    responsibleBody: parsed.data.responsibleBody.trim(),
    dpoContact: parsed.data.dpoContact.trim() || 'nicht benannt',
    supervisoryAuthority: parsed.data.supervisoryAuthority.trim(),
    privacyContact: parsed.data.privacyContact.trim(),
    drittlandServices: parsed.data.drittlandServices.trim() || 'keine',
  };

  await writePrivacyConfig(ctx, cfg);
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'privacy.config.update',
      resourceType: 'tenant_setting',
      after: {
        hasResponsibleBody: cfg.responsibleBody !== '',
        hasSupervisoryAuthority: cfg.supervisoryAuthority !== '',
        hasPrivacyContact: cfg.privacyContact !== '',
      },
    });
  });

  revalidatePath('/staff/admin/privacy');
  return { ok: true };
}
