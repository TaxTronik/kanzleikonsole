import { requireStaffPage } from '@/server/auth/staff-page';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { PortalFeaturesForm } from '../portal-features-form';
import { readPortalInboxRetention } from '@/server/inbox/retention-settings';
import { SectionCard } from '../section-card';

export default async function PortalSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [features, retention] = await Promise.all([
    readPortalFeatures(ctx),
    readPortalInboxRetention(ctx),
  ]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Mandantenportal"
        description="Steuert granular, was der Mandant im Portal tun darf. Diese Einstellungen gelten zusätzlich zu den kanzleiweiten Modul-Schaltern."
      >
        <PortalFeaturesForm initial={features} initialRetention={retention} />
      </SectionCard>
    </div>
  );
}
