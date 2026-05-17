import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { readSmtpConfig } from '@/server/settings/smtp';
import { env } from '@taxtronik/config';
import { SmtpForm } from '../smtp-form';
import { SectionCard } from '../section-card';
import { redirect } from 'next/navigation';

export default async function MailSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  const [smtp, ownerEmail] = await Promise.all([
    readSmtpConfig(ctx),
    // Default-Empfänger für die Test-Mail: eigene E-Mail des angemeldeten Admins
    withTenantContext(ctx, (tx) =>
      tx.staffUser.findUnique({ where: { id: staffId }, select: { email: true } }),
    ),
  ]);

  const envFallback = {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    from: env.SMTP_FROM,
  };

  return (
    <SectionCard
      title="E-Mail-Versand"
      description="SMTP-Konfiguration für transaktionale Mails (Magic-Link-Login, Vollmachten-Einladung, Anforderungs-Reminder). Wenn nichts gespeichert ist, fällt der Versand auf die ENV-Vorgabe zurück."
    >
      <SmtpForm
        initial={smtp}
        envFallback={envFallback}
        defaultTestTo={ownerEmail?.email ?? ''}
      />
    </SectionCard>
  );
}
