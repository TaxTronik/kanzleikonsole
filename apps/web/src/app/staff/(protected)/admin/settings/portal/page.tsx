import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { PortalFeaturesForm } from '../portal-features-form';
import { SectionCard } from '../section-card';

export default async function PortalSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const features = await readPortalFeatures({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Mandantenportal"
        description="Steuert granular, was der Mandant im Portal tun darf. Diese Einstellungen gelten zusätzlich zu den Tenant-weiten Modul-Toggles."
      >
        <PortalFeaturesForm initial={features} />
      </SectionCard>
    </div>
  );
}

export const dynamic = 'force-dynamic';
