import { staffAuth } from '@/server/auth/staff';
import { readTaxRegionSetting } from '@/server/settings/tax-region';
import { TaxRegionForm } from '../tax-region-form';
import { SectionCard } from '../section-card';
import { redirect } from 'next/navigation';

export default async function RegionSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const taxRegion = await readTaxRegionSetting({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <SectionCard
      title="Bundesland"
      description="Bestimmt, welche landesspezifischen Feiertage für die Werktagsverschiebung von Steuerterminen berücksichtigt werden."
    >
      <TaxRegionForm initial={taxRegion.region} initialAssumptionHoliday={taxRegion.assumptionHoliday} />
    </SectionCard>
  );
}
