'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  ActionError,
  parseFormData,
  staffActionGuard,
  type ActionResult,
} from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { writePrivacyConfigTx, type PrivacyConfig } from '@/server/privacy/notice';
import {
  defaultConsentOptionsCatalog,
  normalizeConsentOptionsCatalog,
  type ConsentOptionsCatalog,
} from '@/server/privacy/consent';
import {
  assertConsentCatalogProviderLinksTx,
  CONSENT_OPTIONS_SETTING_KEY,
} from '@/server/privacy/consent-catalog';
import { lockConsentCatalogTx } from '@/server/privacy/catalog-lock';

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

  await withTenantContext(ctx, async (tx) => {
    await lockConsentCatalogTx(tx, tenantId);
    await writePrivacyConfigTx(tx, tenantId, staffId, cfg);
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

const CatalogFormSchema = z.object({
  catalogJson: z.string().min(2).max(100_000),
  expectedRevision: z.union([z.literal('missing'), z.string().datetime()]),
});

function catalogAuditView(catalog: ConsentOptionsCatalog) {
  return catalog.options.map((option) => ({
    id: option.id,
    builtin: option.builtin,
    section: option.section,
    label: option.label,
    description: option.description,
    active: option.active,
    required: option.required,
    recommended: option.recommended,
    sortOrder: option.sortOrder,
    serviceProviderId: option.serviceProviderId,
  }));
}

/** Kanzlei-spezifischer Checkbox-Katalog; Entfernen bedeutet Deaktivieren. */
export async function saveConsentOptionsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const form = parseFormData(CatalogFormSchema, formData);
  if (!form.ok) return { ok: false, error: 'Einwilligungskatalog ist zu groß oder fehlt.' };

  let submitted: ConsentOptionsCatalog;
  try {
    submitted = normalizeConsentOptionsCatalog(JSON.parse(form.data.catalogJson));
  } catch {
    return { ok: false, error: 'Einwilligungskatalog enthält ungültige Angaben.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      await lockConsentCatalogTx(tx, tenantId);
      const stored = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: CONSENT_OPTIONS_SETTING_KEY } },
        select: { value: true, updatedAt: true },
      });
      const currentRevision = stored?.updatedAt.toISOString() ?? 'missing';
      if (currentRevision !== form.data.expectedRevision) {
        throw new ActionError(
          'Der Einwilligungskatalog wurde zwischenzeitlich geändert. Bitte Seite neu laden und Änderungen erneut prüfen.',
        );
      }
      let before = defaultConsentOptionsCatalog();
      let invalidStoredCatalog = false;
      if (stored) {
        try {
          before = normalizeConsentOptionsCatalog(stored.value);
        } catch {
          // Das ACP ist der explizite Reparaturpfad. Laufende Erfassungen
          // bleiben bei einem korrupten Katalog fail-closed, Admins dürfen ihn
          // aber durch einen erneut vollständig validierten Katalog ersetzen.
          invalidStoredCatalog = true;
        }
      }
      // Ein Browser darf Definitionen nicht physisch aus der Historie entfernen.
      // Fehlende bestehende Custom-Optionen werden als inaktiv fortgeschrieben.
      const submittedIds = new Set(submitted.options.map((option) => option.id));
      const removedCustom = before.options
        .filter((option) => !option.builtin && !submittedIds.has(option.id))
        .map((option) => ({
          ...option,
          active: false,
          required: false,
          recommended: false,
        }));
      const next = normalizeConsentOptionsCatalog({
        version: 2,
        options: [...submitted.options, ...removedCustom],
      });

      try {
        await assertConsentCatalogProviderLinksTx(tx, tenantId, next);
      } catch (error) {
        throw new ActionError(
          error instanceof Error
            ? error.message
            : 'Dienstleister-Verknüpfungen konnten nicht validiert werden.',
        );
      }
      if (stored) {
        const updated = await tx.tenantSetting.updateMany({
          where: {
            tenantId,
            key: CONSENT_OPTIONS_SETTING_KEY,
            updatedAt: stored.updatedAt,
          },
          data: { value: next as object, updatedBy: staffId },
        });
        if (updated.count === 0) {
          throw new ActionError(
            'Der Einwilligungskatalog wurde parallel geändert. Bitte Seite neu laden.',
          );
        }
      } else {
        try {
          await tx.tenantSetting.create({
            data: {
              tenantId,
              key: CONSENT_OPTIONS_SETTING_KEY,
              value: next as object,
              updatedBy: staffId,
            },
          });
        } catch (error) {
          if ((error as { code?: string }).code === 'P2002') {
            throw new ActionError(
              'Der Einwilligungskatalog wurde parallel angelegt. Bitte Seite neu laden.',
            );
          }
          throw error;
        }
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'privacy.consent_options.update',
        resourceType: 'tenant_setting',
        resourceId: CONSENT_OPTIONS_SETTING_KEY,
        before: invalidStoredCatalog
          ? { invalidStoredCatalog: true, storedValue: stored?.value ?? null }
          : { version: before.version, options: catalogAuditView(before) },
        after: { version: next.version, options: catalogAuditView(next) },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  revalidatePath('/staff/admin/privacy');
  return { ok: true };
}
