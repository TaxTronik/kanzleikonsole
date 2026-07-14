import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { env } from '@taxtronik/config';
import { readN8nConfig } from '@/server/settings/n8n';
import { readMailDispatch } from '@/server/settings/mail-dispatch';
import { N8nForm } from '../n8n-form';
import { MailDispatchForm } from '../mail-dispatch-form';
import { SectionCard } from '../section-card';

export default async function N8nSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [cfg, dispatch] = await Promise.all([readN8nConfig(ctx), readMailDispatch(ctx)]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Mail-Dispatch"
        description="Wie verschickt die App ausgehende Mails? Per Default versendet die App selbst über die EmailTemplate-Vorlagen — n8n wird nur als ergänzende Integration genutzt."
      >
        <MailDispatchForm initial={dispatch} />
      </SectionCard>

      <SectionCard
        title="n8n-Bridge"
        description="Verbindung zur n8n-Workflow-Engine. Outbound-Pfad: die App schickt Events via signierten Webhook. Inbound-Pfad: n8n ruft die App-API mit gleichem Secret zurück. Optional REST-API für Workflow-Verwaltung aus dieser Oberfläche."
      >
        <N8nForm
          initial={cfg}
          envHints={{
            webhookBaseUrl: env.N8N_WEBHOOK_BASE_URL ?? '',
            hasHmacSecret: Boolean(env.N8N_HMAC_SECRET),
          }}
        />
      </SectionCard>
    </div>
  );
}

export const dynamic = 'force-dynamic';
