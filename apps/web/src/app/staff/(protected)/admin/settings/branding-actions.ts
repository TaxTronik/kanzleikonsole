'use server';

// Kanzlei-Identität: Verkäuferstammdaten, Branding/Logo, Briefkopf, rechtliche
// Hinweise. Aus der früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { writeSellerInfoTx, type SellerInfo } from '@/server/settings/tenant-settings';
import {
  invalidateBrandingCache,
  writeBrandingTx,
  type BrandingInfo,
} from '@/server/settings/branding';
import { writeLetterheadTx, type LetterheadConfig } from '@/server/settings/letterhead';
import { writeLegalTx, type LegalLinks } from '@/server/settings/legal';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { formDefault, parseFormData } from '@/server/actions/form-data';

/** Ländercode wie bisher in Großbuchstaben, fehlend → 'DE'. */
const CountryIsoField = z.preprocess(
  (value) => (typeof value === 'string' ? value.toUpperCase() : (value ?? 'DE')),
  z.string().length(2).default('DE'),
);

const SellerSchema = z.object({
  name: z.string().min(1).max(200),
  street: formDefault('', z.string().max(200).optional().or(z.literal(''))),
  postalCode: formDefault('', z.string().max(20).optional().or(z.literal(''))),
  city: formDefault('', z.string().max(100).optional().or(z.literal(''))),
  countryIso: CountryIsoField,
  vatId: formDefault('', z.string().max(50).optional().or(z.literal(''))),
  taxNumber: formDefault('', z.string().max(50).optional().or(z.literal(''))),
  email: formDefault('', z.string().email().max(255).optional().or(z.literal(''))),
  phone: formDefault('', z.string().max(50).optional().or(z.literal(''))),
  iban: formDefault('', z.string().max(50).optional().or(z.literal(''))),
  bic: formDefault('', z.string().max(20).optional().or(z.literal(''))),
  bankName: formDefault('', z.string().max(200).optional().or(z.literal(''))),
});

export async function saveSellerInfoAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(SellerSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const { ctx } = g;
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

      await withTenantContext(ctx, async (tx) => {
        await writeSellerInfoTx(tx, ctx, info);
        await audit(tx, g, {
          action: 'tenant.settings.seller.update',
          resourceType: 'tenant_setting',
          resourceId: 'invoicing.seller',
          after: { name: info.name, vatId: info.vatId, iban: info.iban ? '***' : null },
        });
      });
    },
    revalidate: '/staff/admin/settings',
  });
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
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Hex-Farbe wie #2563eb')
    .transform((s) => s.toLowerCase()),
  subtitle: formDefault('', z.string().max(100).optional().or(z.literal(''))),
  logoDataUrl: formDefault('', z.string().max(MAX_LOGO_DATAURL_LEN).optional().or(z.literal(''))),
  logoDataUrlDark: formDefault(
    '',
    z.string().max(MAX_LOGO_DATAURL_LEN).optional().or(z.literal('')),
  ),
});

export async function saveBrandingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(BrandingSchema, formData, {
        absentAsNull: true,
        errorMessage: (issues) => issues.map((i) => i.message).join('; '),
      });
      if (!parsed.ok) return parsed;

      const logoStr = parsed.data.logoDataUrl ?? '';
      if (logoStr && !LOGO_DATAURL_RE.test(logoStr)) {
        return { ok: false, error: 'Ungültiges Logo-Format.' };
      }
      const logoDarkStr = parsed.data.logoDataUrlDark ?? '';
      if (logoDarkStr && !LOGO_DATAURL_RE.test(logoDarkStr)) {
        return { ok: false, error: 'Ungültiges Dark-Logo-Format.' };
      }

      const { tenantId, ctx } = g;
      const info: BrandingInfo = {
        displayName: parsed.data.displayName,
        accentColor: parsed.data.accentColor,
        subtitle: parsed.data.subtitle || null,
        logoDataUrl: logoStr || null,
        logoDataUrlDark: logoDarkStr || null,
      };

      await withTenantContext(ctx, async (tx) => {
        await writeBrandingTx(tx, ctx, info);
        await audit(tx, g, {
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
      // Prozessweiten Branding-Cache nach dem Commit verwerfen (layout-settings.ts).
      invalidateBrandingCache(tenantId);

      revalidatePath('/staff/admin/settings');
      // Layout cachen: Branding wirkt erst auf der nächsten Anfrage
      revalidatePath('/staff', 'layout');
    },
  });
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
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(LetterheadSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const { ctx } = g;
      const cfg: LetterheadConfig = parsed.data;
      await withTenantContext(ctx, async (tx) => {
        await writeLetterheadTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.letterhead.update',
          resourceType: 'tenant_setting',
          resourceId: 'branding.letterhead',
          after: cfg,
        });
      });
    },
    revalidate: '/staff/admin/settings/branding',
  });
}

// ----------------------------------------------------------------------------
// Rechtliche Hinweise (Impressum + Datenschutzerklärung)
// Wird auf Login-Seiten verlinkt — Pflicht für Telemediengesetz / DSGVO.
// ----------------------------------------------------------------------------

const LegalSchema = z.object({
  impressumUrl: formDefault('', z.string().url().max(500).or(z.literal(''))),
  privacyUrl: formDefault('', z.string().url().max(500).or(z.literal(''))),
});

export async function saveLegalAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(LegalSchema, formData, {
        absentAsNull: true,
        errorMessage: (issues) => issues[0]?.message ?? 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const { ctx } = g;
      const cfg: LegalLinks = parsed.data;
      await withTenantContext(ctx, async (tx) => {
        await writeLegalTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.legal.update',
          resourceType: 'tenant_setting',
          resourceId: 'legal',
          after: cfg,
        });
      });
    },
    revalidate: ['/staff/admin/settings/branding', '/staff/admin/privacy'],
  });
}
