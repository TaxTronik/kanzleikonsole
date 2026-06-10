// =============================================================================
// Minimaler SMTP-Versand für Betriebs-Alarme (health-alert).
//
// Bewusst NICHT der Template-/Dispatch-Stack der Web-App (Markdown, Branding,
// Audit): Betriebs-Alarme sind Plaintext an EINE Ops-Adresse und müssen auch
// dann funktionieren, wenn App/DB down sind — je weniger Abhängigkeiten,
// desto eher kommt die Mail durch. Konfiguration identisch zur App (SMTP_*).
// =============================================================================

import { createTransport, type Transporter } from 'nodemailer';
import { env } from '@taxtronik/config';
import { log } from './logger';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // Wie der App-Mailer: 465 = implizites TLS, sonst STARTTLS-Upgrade.
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  return transporter;
}

/** CRLF-Strip gegen Header-Injection — Subject kommt teils aus Fehlertexten. */
function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/**
 * Plaintext-Mail an die Ops-Adresse. Wirft NICHT — wenn SMTP selbst down ist,
 * kann der Alarm nur noch ins Log (der Aufrufer darf daran nicht sterben).
 */
export async function sendOpsMail(subject: string, body: string): Promise<boolean> {
  const to = env.OPS_ALERT_EMAIL;
  if (!to) return false;
  try {
    await getTransporter().sendMail({
      from: env.SMTP_FROM,
      to,
      subject: headerSafe(subject),
      text: body,
    });
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message, subject }, 'ops-mail: send failed');
    return false;
  }
}
