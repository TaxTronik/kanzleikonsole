import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { env } from '@taxtronik/config';
import { TSA_PROVIDERS } from '@taxtronik/evidence';
import { readTsaConfig } from '@/server/settings/tsa';
import { TsaForm } from '../tsa-form';
import { SectionCard } from '../section-card';

export default async function EvidenceSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const tsa = await readTsaConfig(ctx);

  return (
    <SectionCard
      title="Zeitstempel-Behörde (TSA)"
      description="Externe RFC-3161-Stelle, die täglich den Spitzen-Hash der Audit-Chain versiegelt. In Produktion ist eine externe TSA Pflicht; Self-Timestamp ist nur für lokale Tests zulässig."
    >
      <TsaForm
        initial={tsa}
        providers={TSA_PROVIDERS}
        envFallback={env.TIMESTAMP_AUTHORITY_URL ?? null}
        production={env.NODE_ENV === 'production'}
      />
    </SectionCard>
  );
}

// Health-Checks und TSA-Verbindungstests sollen frisch sein
export const dynamic = 'force-dynamic';
