'use server';

// E-Mail-Versand: SMTP-Konfiguration (+ Test-Mail) und Dispatch-Modus
// (App / App+n8n). Aus der früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  readSmtpConfig,
  writeSmtpConfigTx,
  deleteSmtpConfigTx,
  type SmtpConfig,
} from '@/server/settings/smtp';
import { sendTestMail } from '@/server/mail/send';
import { writeMailDispatchTx, type MailDispatchConfig } from '@/server/settings/mail-dispatch';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { log } from '@/server/logger';

/** Bekannte Nodemailer-Fehlercodes des SMTP-Tests. */
const SMTP_TEST_MESSAGES: Readonly<Record<string, string>> = {
  EAUTH: 'Anmeldung am SMTP-Server abgelehnt — Benutzer und Passwort prüfen.',
  ECONNECTION: 'SMTP-Server nicht erreichbar — Host und Port prüfen.',
  ETIMEDOUT: 'SMTP-Server hat nicht rechtzeitig geantwortet.',
  EDNS: 'SMTP-Host ist nicht auflösbar.',
  ETLS: 'TLS-Verbindung zum SMTP-Server fehlgeschlagen — Verschlüsselung prüfen.',
  EENVELOPE: 'Absender oder Empfänger wurde vom SMTP-Server abgelehnt.',
};

/**
 * F-03: SMTP-Testfehler über Fehlercode und SMTP-Antwortcode statt Rohtext
 * (der Server-Text kann interne Hosts enthalten); Details im Server-Log.
 */
function smtpTestErrorMessage(error: unknown): string {
  const fields = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof fields.code === 'string' ? fields.code : null;
  const responseCode = typeof fields.responseCode === 'number' ? fields.responseCode : null;
  log.warn(
    {
      component: 'smtp-test',
      code,
      responseCode,
      err: error instanceof Error ? error.message : String(error),
    },
    'SMTP-Test fehlgeschlagen',
  );
  const smtpStatus = responseCode ? ` (SMTP ${responseCode})` : '';
  const known = code ? SMTP_TEST_MESSAGES[code] : undefined;
  if (known) return `${known}${smtpStatus}`;
  return `unbekannter Fehler${smtpStatus || (code ? ` (${code})` : '')}. Details stehen im Server-Log.`;
}

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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;
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
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

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
  await withTenantContext(ctx, async (tx) => {
    await writeSmtpConfigTx(tx, ctx, cfg);
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;
  await withTenantContext(ctx, async (tx) => {
    await deleteSmtpConfigTx(tx, ctx);
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { ctx } = g;
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
    return { ok: false, error: `Versand fehlgeschlagen: ${smtpTestErrorMessage(e)}` };
  }
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;
  const parsed = MailDispatchSchema.safeParse({
    mode: formData.get('mode'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const cfg: MailDispatchConfig = parsed.data;
  await withTenantContext(ctx, async (tx) => {
    await writeMailDispatchTx(tx, ctx, cfg);
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
