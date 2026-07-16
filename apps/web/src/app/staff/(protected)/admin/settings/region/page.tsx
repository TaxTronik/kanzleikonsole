import { requireStaffPage } from '@/server/auth/staff-page';
import { readTaxRegionSetting } from '@/server/settings/tax-region';
import { TaxRegionForm } from '../tax-region-form';
import { SectionCard } from '../section-card';

export default async function RegionSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const taxRegion = await readTaxRegionSetting({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <SectionCard
      title="Bundesland"
      description="Bestimmt, welche landesspezifischen Feiertage für die Werktagsverschiebung von Steuerterminen berücksichtigt werden."
    >
      <TaxRegionForm
        initial={taxRegion.region}
        initialAssumptionHoliday={taxRegion.assumptionHoliday}
      />
    </SectionCard>
  );
}
