'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { assertPublicHost } from '@/server/http/ssrf-guard';
import { writeSellerInfo, type SellerInfo } from '@/server/settings/tenant-settings';
import { writeBranding, type BrandingInfo } from '@/server/settings/branding';
import { writeModules, type ModuleConfig } from '@/server/settings/modules';
import { writeAccessPolicy, type ClientAccessMode } from '@/server/settings/access-policy';
import { writeTaxRegion } from '@/server/settings/tax-region';
import type { GermanRegion } from '@taxtronik/tax';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  readSmtpConfig,
  writeSmtpConfig,
  deleteSmtpConfig,
  type SmtpConfig,
} from '@/server/settings/smtp';
import { sendTestMail } from '@/server/mail/send';
import { writeTsaConfig, type TsaConfig } from '@/server/settings/tsa';
import { Rfc3161HttpAdapter, getTsaProvider } from '@taxtronik/evidence';
import { randomBytes } from 'node:crypto';
import { writeLetterhead, type LetterheadConfig } from '@/server/settings/letterhead';
import { writeLegal, type LegalLinks } from '@/server/settings/legal';
import { writeMailDispatch, type MailDispatchConfig } from '@/server/settings/mail-dispatch';
import { writeClientLayout, ALL_CLIENT_BLOCKS, DEFAULT_CLIENT_LAYOUT, type ClientBlockKey, type ClientGridItem } from '@/server/settings/client-layout';
import { writePortalFeatures, type PortalFeatures } from '@/server/settings/portal-features';

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

export interface ActionResult { ok: boolean; error?: string; }

export async function saveSellerInfoAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

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

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
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

  // Audit
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
});

export async function saveBrandingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = BrandingSchema.safeParse({
    displayName: formData.get('displayName'),
    accentColor: formData.get('accentColor'),
    subtitle: formData.get('subtitle') ?? '',
    logoDataUrl: formData.get('logoDataUrl') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  const logoStr = parsed.data.logoDataUrl ?? '';
  if (logoStr && !LOGO_DATAURL_RE.test(logoStr)) {
    return { ok: false, error: 'Ungültiges Logo-Format.' };
  }

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const info: BrandingInfo = {
    displayName: parsed.data.displayName,
    accentColor: parsed.data.accentColor,
    subtitle: parsed.data.subtitle || null,
    logoDataUrl: logoStr || null,
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
      // logoDataUrl absichtlich weglassen — würde audit_log mit base64 fluten
      after: { ...info, logoDataUrl: info.logoDataUrl ? '<data-url>' : null },
    });
  });

  revalidatePath('/staff/admin/settings');
  // Layout cachen: Branding wirkt erst auf der nächsten Anfrage
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Module + Vollmachten-Modus
// ----------------------------------------------------------------------------

const ModulesSchema = z.object({
  bwa: z.boolean(),
  knowledge: z.boolean(),
  timeTracking: z.boolean(),
  phoneNotes: z.boolean(),
  taxNotices: z.boolean(),
  workflows: z.boolean(),
  forms: z.boolean(),
  reminders: z.boolean(),
  binders: z.boolean(),
  handovers: z.boolean(),
  appointments: z.boolean(),
  rssReader: z.boolean(),
  inboundMail: z.boolean(),
  risk: z.boolean(),
  poaMode: z.enum(['OFF', 'MARKDOWN_OTP', 'PDF_TEMPLATE']),
  poaPdfSubject: z.string().max(200).optional(),
  poaPdfBodyMd: z.string().max(5000).optional(),
  invoiceMode: z.enum(['OFF', 'IN_APP', 'EXTERNAL']),
  invoicePdfSubject: z.string().max(200).optional(),
  invoicePdfBodyMd: z.string().max(5000).optional(),
});

export async function saveModulesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = ModulesSchema.safeParse({
    bwa: formData.get('enabled.bwa') === 'on',
    knowledge: formData.get('enabled.knowledge') === 'on',
    timeTracking: formData.get('enabled.timeTracking') === 'on',
    phoneNotes: formData.get('enabled.phoneNotes') === 'on',
    taxNotices: formData.get('enabled.taxNotices') === 'on',
    workflows: formData.get('enabled.workflows') === 'on',
    forms: formData.get('enabled.forms') === 'on',
    reminders: formData.get('enabled.reminders') === 'on',
    binders: formData.get('enabled.binders') === 'on',
    handovers: formData.get('enabled.handovers') === 'on',
    appointments: formData.get('enabled.appointments') === 'on',
    rssReader: formData.get('enabled.rssReader') === 'on',
    inboundMail: formData.get('enabled.inboundMail') === 'on',
    risk: formData.get('enabled.risk') === 'on',
    poaMode: formData.get('poaMode'),
    poaPdfSubject: formData.get('poaPdfSubject') ?? '',
    poaPdfBodyMd: formData.get('poaPdfBodyMd') ?? '',
    invoiceMode: formData.get('invoiceMode'),
    invoicePdfSubject: formData.get('invoicePdfSubject') ?? '',
    invoicePdfBodyMd: formData.get('invoicePdfBodyMd') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: ModuleConfig = {
    bwa: parsed.data.bwa,
    knowledge: parsed.data.knowledge,
    timeTracking: parsed.data.timeTracking,
    phoneNotes: parsed.data.phoneNotes,
    taxNotices: parsed.data.taxNotices,
    workflows: parsed.data.workflows,
    forms: parsed.data.forms,
    reminders: parsed.data.reminders,
    binders: parsed.data.binders,
    handovers: parsed.data.handovers,
    appointments: parsed.data.appointments,
    rssReader: parsed.data.rssReader,
    inboundMail: parsed.data.inboundMail,
    risk: parsed.data.risk,
    poaMode: parsed.data.poaMode,
    poaPdfTemplate:
      parsed.data.poaMode === 'PDF_TEMPLATE'
        ? {
            subject: (parsed.data.poaPdfSubject ?? '').trim() || 'Vollmacht zur Unterzeichnung',
            bodyMd: (parsed.data.poaPdfBodyMd ?? '').trim(),
          }
        : null,
    invoiceMode: parsed.data.invoiceMode,
    invoicePdfTemplate:
      parsed.data.invoiceMode === 'EXTERNAL'
        ? {
            subject: (parsed.data.invoicePdfSubject ?? '').trim() || 'Ihre Rechnung',
            bodyMd: (parsed.data.invoicePdfBodyMd ?? '').trim(),
          }
        : null,
  };

  await writeModules(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.modules.update',
      resourceType: 'tenant_setting',
      resourceId: 'modules',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings');
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Zugriffsmodell (OPEN / RESTRICTED) — wie weit Mitarbeiter mandantenübergreifend arbeiten
// ----------------------------------------------------------------------------

const AccessPolicySchema = z.object({
  clientAccessMode: z.enum(['OPEN', 'RESTRICTED']),
});

export async function saveAccessPolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = AccessPolicySchema.safeParse({ clientAccessMode: formData.get('clientAccessMode') });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg = { clientAccessMode: parsed.data.clientAccessMode as ClientAccessMode };
  await writeAccessPolicy(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.access_policy.update',
      resourceType: 'tenant_setting',
      resourceId: 'access',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings/modules');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// SMTP (E-Mail-Versand) — tenant-spezifisch, Passwort verschlüsselt
// ----------------------------------------------------------------------------

const SmtpSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255).optional().or(z.literal('')),
  password: z.string().max(500).optional().or(z.literal('')),
  from: z.string().min(1).max(255),
  replyTo: z.string().max(255).optional().or(z.literal('')),
  /** Wenn `true`: bestehendes Passwort aus DB beibehalten (Form schickt leer). */
  keepPassword: z.boolean().default(false),
});

const TestMailSchema = SmtpSchema.extend({
  testTo: z.string().email().max(255),
});

export async function saveSmtpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = SmtpSchema.safeParse({
    host: formData.get('host'),
    port: formData.get('port'),
    secure: formData.get('secure') === 'on',
    user: formData.get('user') ?? '',
    password: formData.get('password') ?? '',
    from: formData.get('from'),
    replyTo: formData.get('replyTo') ?? '',
    keepPassword: formData.get('keepPassword') === 'on',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  let password = parsed.data.password ?? '';
  if (parsed.data.keepPassword) {
    const existing = await readSmtpConfig(ctx);
    password = existing?.password ?? '';
  }

  const cfg: SmtpConfig = {
    host: parsed.data.host.trim(),
    port: parsed.data.port,
    secure: parsed.data.secure,
    user: (parsed.data.user ?? '').trim(),
    password,
    from: parsed.data.from.trim(),
    replyTo: (parsed.data.replyTo ?? '').trim(),
  };
  await writeSmtpConfig(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.smtp.update',
      resourceType: 'tenant_setting',
      resourceId: 'mail.smtp',
      after: {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user || null,
        from: cfg.from,
        replyTo: cfg.replyTo || null,
        password: cfg.password ? '***' : null,
      },
    });
  });

  revalidatePath('/staff/admin/settings/mail');
  revalidatePath('/staff/admin');
  return { ok: true };
}

export async function resetSmtpAction(): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await deleteSmtpConfig(ctx);
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.smtp.reset',
      resourceType: 'tenant_setting',
      resourceId: 'mail.smtp',
      after: null,
    });
  });
  revalidatePath('/staff/admin/settings/mail');
  revalidatePath('/staff/admin');
  return { ok: true };
}

export async function sendTestMailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = TestMailSchema.safeParse({
    host: formData.get('host'),
    port: formData.get('port'),
    secure: formData.get('secure') === 'on',
    user: formData.get('user') ?? '',
    password: formData.get('password') ?? '',
    from: formData.get('from'),
    replyTo: formData.get('replyTo') ?? '',
    keepPassword: formData.get('keepPassword') === 'on',
    testTo: formData.get('testTo'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  let password = parsed.data.password ?? '';
  if (parsed.data.keepPassword) {
    const existing = await readSmtpConfig(ctx);
    password = existing?.password ?? '';
  }

  const cfg: SmtpConfig = {
    host: parsed.data.host.trim(),
    port: parsed.data.port,
    secure: parsed.data.secure,
    user: (parsed.data.user ?? '').trim(),
    password,
    from: parsed.data.from.trim(),
    replyTo: (parsed.data.replyTo ?? '').trim(),
  };

  try {
    await sendTestMail(cfg, parsed.data.testTo);
  } catch (e) {
    return { ok: false, error: `Versand fehlgeschlagen: ${(e as Error).message}` };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Bundesland (für Steuertermin-Feiertage)
// ----------------------------------------------------------------------------

const VALID_REGIONS: GermanRegion[] = [
  'DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
  'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH',
];

const TaxRegionSchema = z.object({
  region: z.string().optional().or(z.literal('')),
});

export async function saveTaxRegionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = TaxRegionSchema.safeParse({ region: formData.get('region') ?? '' });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const raw = parsed.data.region ?? '';
  const region: GermanRegion | null =
    raw && (VALID_REGIONS as readonly string[]).includes(raw) ? (raw as GermanRegion) : null;

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await writeTaxRegion(ctx, region);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.tax_region.update',
      resourceType: 'tenant_setting',
      resourceId: 'tax_region',
      after: { region },
    });
  });

  revalidatePath('/staff/admin/settings');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// TSA (RFC-3161-Zeitstempel-Behörde)
// ----------------------------------------------------------------------------

const TsaSchema = z.object({
  providerId: z.string().max(50),
  customUrl: z.string().max(500).optional().or(z.literal('')),
});

function resolveTsaUrlFromInput(input: { providerId: string; customUrl: string }): string | null {
  if (!input.providerId) return null;
  if (input.providerId === 'custom') return input.customUrl.trim() || null;
  const p = getTsaProvider(input.providerId);
  return p?.url || null;
}

export async function saveTsaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = TsaSchema.safeParse({
    providerId: formData.get('providerId') ?? '',
    customUrl: formData.get('customUrl') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  if (parsed.data.providerId === 'custom' && !(parsed.data.customUrl ?? '').trim()) {
    return { ok: false, error: 'Bei „Eigener TSA-Server" eine URL angeben.' };
  }

  // NEW1: SSRF-Schutz. Bei Custom-TSA-URL prüfen, dass sie nicht auf
  // private Adressen zeigt — der Worker würde sie täglich anfetchen.
  if (parsed.data.providerId === 'custom') {
    try {
      await assertPublicHost(parsed.data.customUrl!.trim());
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: TsaConfig = {
    providerId: parsed.data.providerId,
    customUrl: parsed.data.customUrl ?? '',
  };
  await writeTsaConfig(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.tsa.update',
      resourceType: 'tenant_setting',
      resourceId: 'evidence.tsa',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings/evidence');
  revalidatePath('/staff/admin');
  return { ok: true };
}

export async function testTsaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = TsaSchema.safeParse({
    providerId: formData.get('providerId') ?? '',
    customUrl: formData.get('customUrl') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const url = resolveTsaUrlFromInput({
    providerId: parsed.data.providerId,
    customUrl: parsed.data.customUrl ?? '',
  });
  if (!url) return { ok: false, error: 'Kein Server gewählt.' };

  // NEW1: SSRF-Schutz auch beim Test (Admin-supplied URL nicht direkt fetchen).
  try {
    await assertPublicHost(url);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    const adapter = new Rfc3161HttpAdapter(url, 8_000);
    const result = await adapter.timestamp(randomBytes(32));
    return {
      ok: true,
      error: `Antwort ${result.tsaResponseBlob?.byteLength ?? 0} Bytes — Status granted (${result.timestampedAt}).`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = LetterheadSchema.safeParse({
    organisationName: formData.get('organisationName'),
    addressLines: formData.get('addressLines'),
    contactLine: formData.get('contactLine'),
    footnote: formData.get('footnote'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = LegalSchema.safeParse({
    impressumUrl: formData.get('impressumUrl') ?? '',
    privacyUrl: formData.get('privacyUrl') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
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

// ----------------------------------------------------------------------------
// Mail-Dispatch (App / App + n8n parallel)
// ----------------------------------------------------------------------------

const MailDispatchSchema = z.object({
  mode: z.enum(['APP', 'BOTH']),
});

export async function saveMailDispatchAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = MailDispatchSchema.safeParse({
    mode: formData.get('mode'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: MailDispatchConfig = parsed.data;
  await writeMailDispatch(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.mail_dispatch.update',
      resourceType: 'tenant_setting',
      resourceId: 'mail.dispatch',
      after: cfg,
    });
  });
  revalidatePath('/staff/admin/settings/n8n');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Mandanten-Cockpit-Layout (12-Spalten-Grid analog Dashboard, aber Tenant-global)
// ----------------------------------------------------------------------------

const BlockKeyEnum = z.enum(ALL_CLIENT_BLOCKS as [ClientBlockKey, ...ClientBlockKey[]]);

const ClientLayoutSchema = z.object({
  items: z.array(
    z.object({
      id: BlockKeyEnum,
      x: z.number().int().min(0).max(11),
      y: z.number().int().min(0).max(200),
      w: z.number().int().min(2).max(12),
      h: z.number().int().min(2).max(40),
    }),
  ).min(1).max(20),
});

export async function saveClientLayoutAction(input: { items: ClientGridItem[] }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = ClientLayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await writeClientLayout(ctx, { items: parsed.data.items });

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.client_layout.update',
      resourceType: 'tenant_setting',
      resourceId: 'client_detail.layout',
      after: { itemCount: parsed.data.items.length },
    });
  });
  revalidatePath('/staff/admin/settings/modules');
  revalidatePath('/staff/clients', 'layout');
  return { ok: true };
}

export async function resetClientLayoutAction(): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await writeClientLayout(ctx, DEFAULT_CLIENT_LAYOUT);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.client_layout.update',
      resourceType: 'tenant_setting',
      resourceId: 'client_detail.layout',
      after: { reset: true },
    });
  });
  revalidatePath('/staff/admin/settings/modules');
  revalidatePath('/staff/clients', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Mandantenportal-Feature-Flags
// ----------------------------------------------------------------------------

const PortalFeaturesSchema = z.object({
  appointmentRequests: z.boolean(),
  bwaView: z.boolean(),
  bwaPlanning: z.boolean(),
  documentUpload: z.boolean(),
  stammdatenSelfService: z.boolean(),
  handoversView: z.boolean(),
});

export async function savePortalFeaturesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = PortalFeaturesSchema.safeParse({
    appointmentRequests: formData.get('appointmentRequests') === 'on',
    bwaView: formData.get('bwaView') === 'on',
    bwaPlanning: formData.get('bwaPlanning') === 'on',
    documentUpload: formData.get('documentUpload') === 'on',
    stammdatenSelfService: formData.get('stammdatenSelfService') === 'on',
    handoversView: formData.get('handoversView') === 'on',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: PortalFeatures = parsed.data;
  await writePortalFeatures(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.portal_features.update',
      resourceType: 'tenant_setting',
      resourceId: 'portal.features',
      after: cfg,
    });
  });
  revalidatePath('/staff/admin/settings/portal');
  revalidatePath('/portal', 'layout');
  return { ok: true };
}
