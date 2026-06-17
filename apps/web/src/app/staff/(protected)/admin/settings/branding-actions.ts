'use server';

// Kanzlei-Identität: Verkäuferstammdaten, Branding/Logo, Briefkopf, rechtliche
// Hinweise. Aus der früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { writeSellerInfo, type SellerInfo } from '@/server/settings/tenant-settings';
import { writeBranding, type BrandingInfo } from '@/server/settings/branding';
import { writeLetterhead, type LetterheadConfig } from '@/server/settings/letterhead';
import { writeLegal, type LegalLinks } from '@/server/settings/legal';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';

const SellerSchema = z.object({
  name: z.string().min(1).max(200),
  street: z.string().max(200).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  countryIso: z.string().length(2).default('DE'),
  vatId: z.string().max(50).optional().or(z.literal('')),
  taxNumber: z.string().max(50).optional().or(z.literal('')),
  email: z.string().email().max(255).optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  iban: z.string().max(50).optional().or(z.literal('')),
  bic: z.string().max(20).optional().or(z.literal('')),
  bankName: z.string().max(200).optional().or(z.literal('')),
});

export async function saveSellerInfoAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;

  const parsed = SellerSchema.safeParse({
    name: formData.get('name'),
    street: formData.get('street') ?? '',
    postalCode: formData.get('postalCode') ?? '',
    city: formData.get('city') ?? '',
    countryIso: (formData.get('countryIso') as string)?.toUpperCase() ?? 'DE',
    vatId: formData.get('vatId') ?? '',
    taxNumber: formData.get('taxNumber') ?? '',
    email: formData.get('email') ?? '',
    phone: formData.get('phone') ?? '',
    iban: formData.get('iban') ?? '',
    bic: formData.get('bic') ?? '',
    bankName: formData.get('bankName') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId, ctx } = g;
  const info: SellerInfo = {
    name: parsed.data.name,
    street: parsed.data.street || null,
    postalCode: parsed.data.postalCode || null,
    city: parsed.data.city || null,
    countryIso: parsed.data.countryIso,
    vatId: parsed.data.vatId || null,
    taxNumber: parsed.data.taxNumber || null,
    email: parsed.data.email || null,
    phone: parsed.data.phone || null,
    iban: parsed.data.iban || null,
    bic: parsed.data.bic || null,
    bankName: parsed.data.bankName || null,
  };

  await writeSellerInfo(ctx, info);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.seller.update',
      resourceType: 'tenant_setting',
      resourceId: 'invoicing.seller',
      after: { name: info.name, vatId: info.vatId, iban: info.iban ? '***' : null },
    });
  });

  revalidatePath('/staff/admin/settings');
  return { ok: true };
}

const MAX_LOGO_DATAURL_LEN = 320 * 1024; // ~240 KB binary nach base64
// NEW3: SVG bewusst aus der Whitelist entfernt. Browser-<img> blockt zwar
// inline-Scripts in SVG, aber das gespeicherte Data-URL ist ein Foot-Gun
// für jeden, der es später in <object>/<iframe> oder CSS background-image
// kopiert. Außerdem inkonsistent zur preview-mime.ts-Whitelist, die SVG
// ebenfalls ablehnt. PNG/JPEG/WebP reichen für Kanzlei-Logos.
const LOGO_DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

const BrandingSchema = z.object({
  displayName: z.string().min(1).max(100),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Hex-Farbe wie #2563eb').transform((s) => s.toLowerCase()),
  subtitle: z.string().max(100).optional().or(z.literal('')),
  logoDataUrl: z.string().max(MAX_LOGO_DATAURL_LEN).optional().or(z.literal('')),
  logoDataUrlDark: z.string().max(MAX_LOGO_DATAURL_LEN).optional().or(z.literal('')),
});

export async function saveBrandingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;

  const parsed = BrandingSchema.safeParse({
    displayName: formData.get('displayName'),
    accentColor: formData.get('accentColor'),
    subtitle: formData.get('subtitle') ?? '',
    logoDataUrl: formData.get('logoDataUrl') ?? '',
    logoDataUrlDark: formData.get('logoDataUrlDark') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  const logoStr = parsed.data.logoDataUrl ?? '';
  if (logoStr && !LOGO_DATAURL_RE.test(logoStr)) {
    return { ok: false, error: 'Ungültiges Logo-Format.' };
  }
  const logoDarkStr = parsed.data.logoDataUrlDark ?? '';
  if (logoDarkStr && !LOGO_DATAURL_RE.test(logoDarkStr)) {
    return { ok: false, error: 'Ungültiges Dark-Logo-Format.' };
  }

  const { tenantId, staffId, ctx } = g;
  const info: BrandingInfo = {
    displayName: parsed.data.displayName,
    accentColor: parsed.data.accentColor,
    subtitle: parsed.data.subtitle || null,
    logoDataUrl: logoStr || null,
    logoDataUrlDark: logoDarkStr || null,
  };

  await writeBranding(ctx, info);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.branding.update',
      resourceType: 'tenant_setting',
      resourceId: 'branding',
      // logoDataUrl(+-Dark) absichtlich weglassen — würde audit_log mit base64
      // fluten.
      after: {
        ...info,
        logoDataUrl: info.logoDataUrl ? '<data-url>' : null,
        logoDataUrlDark: info.logoDataUrlDark ? '<data-url>' : null,
      },
    });
  });

  revalidatePath('/staff/admin/settings');
  // Layout cachen: Branding wirkt erst auf der nächsten Anfrage
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Briefkopf (für PDF-Exporte)
// ----------------------------------------------------------------------------

const LetterheadSchema = z.object({
  organisationName: z.string().max(200).default(''),
  addressLines: z.string().max(1000).default(''),
  contactLine: z.string().max(500).default(''),
  footnote: z.string().max(1000).default(''),
});

export async function saveLetterheadAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = LetterheadSchema.safeParse({
    organisationName: formData.get('organisationName'),
    addressLines: formData.get('addressLines'),
    contactLine: formData.get('contactLine'),
    footnote: formData.get('footnote'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId, ctx } = g;
  const cfg: LetterheadConfig = parsed.data;
  await writeLetterhead(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.letterhead.update',
      resourceType: 'tenant_setting',
      resourceId: 'branding.letterhead',
      after: cfg,
    });
  });
  revalidatePath('/staff/admin/settings/branding');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Rechtliche Hinweise (Impressum + Datenschutzerklärung)
// Wird auf Login-Seiten verlinkt — Pflicht für Telemediengesetz / DSGVO.
// ----------------------------------------------------------------------------

const LegalSchema = z.object({
  impressumUrl: z.string().url().max(500).or(z.literal('')),
  privacyUrl: z.string().url().max(500).or(z.literal('')),
});

export async function saveLegalAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = LegalSchema.safeParse({
    impressumUrl: formData.get('impressumUrl') ?? '',
    privacyUrl: formData.get('privacyUrl') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }

  const { tenantId, staffId, ctx } = g;
  const cfg: LegalLinks = parsed.data;
  await writeLegal(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.legal.update',
      resourceType: 'tenant_setting',
      resourceId: 'legal',
      after: cfg,
    });
  });
  revalidatePath('/staff/admin/settings/branding');
  return { ok: true };
}
