'use server';

// E-Mail-Versand: SMTP-Konfiguration (+ Test-Mail) und Dispatch-Modus
// (App / App+n8n). Aus der früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import {
  readSmtpConfig,
  writeSmtpConfigTx,
  deleteSmtpConfigTx,
  type SmtpConfig,
} from '@/server/settings/smtp';
import { sendTestMail } from '@/server/mail/send';
import { writeMailDispatchTx, type MailDispatchConfig } from '@/server/settings/mail-dispatch';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { formDefault, formFlag, parseFormData } from '@/server/actions/form-data';
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
  secure: formFlag(),
  user: formDefault('', z.string().max(255).optional().or(z.literal(''))),
  password: formDefault('', z.string().max(500).optional().or(z.literal(''))),
  from: z.string().min(1).max(255),
  replyTo: formDefault('', z.string().max(255).optional().or(z.literal(''))),
  /** Wenn `true`: bestehendes Passwort aus DB beibehalten (Form schickt leer). */
  keepPassword: formFlag('on', z.boolean().default(false)),
});

const TestMailSchema = SmtpSchema.extend({
  testTo: z.string().email().max(255),
});

export async function saveSmtpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const { ctx } = g;
      const parsed = parseFormData(SmtpSchema, formData, {
        absentAsNull: true,
        errorMessage: (issues) => issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      if (!parsed.ok) return parsed;

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
        await audit(tx, g, {
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
    },
    revalidate: ['/staff/admin/settings/mail', '/staff/admin'],
  });
}

export async function resetSmtpAction(): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const { ctx } = g;
      await withTenantContext(ctx, async (tx) => {
        await deleteSmtpConfigTx(tx, ctx);
        await audit(tx, g, {
          action: 'tenant.settings.smtp.reset',
          resourceType: 'tenant_setting',
          resourceId: 'mail.smtp',
          after: null,
        });
      });
    },
    revalidate: ['/staff/admin/settings/mail', '/staff/admin'],
  });
}

export async function sendTestMailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async ({ ctx }) => {
      const parsed = parseFormData(TestMailSchema, formData, {
        absentAsNull: true,
        errorMessage: (issues) => issues.map((i) => i.message).join('; '),
      });
      if (!parsed.ok) return parsed;

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
    },
  });
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
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const { ctx } = g;
      const parsed = parseFormData(MailDispatchSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const cfg: MailDispatchConfig = parsed.data;
      await withTenantContext(ctx, async (tx) => {
        await writeMailDispatchTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.mail_dispatch.update',
          resourceType: 'tenant_setting',
          resourceId: 'mail.dispatch',
          after: cfg,
        });
      });
    },
    revalidate: '/staff/admin/settings/n8n',
  });
}
