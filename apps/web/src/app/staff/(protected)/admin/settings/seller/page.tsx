import { requireStaffPage } from '@/server/auth/staff-page';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { SellerForm } from '../seller-form';
import { SectionCard } from '../section-card';

export default async function SellerSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const seller = await readSellerInfo({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <SectionCard
      title="Kanzlei-Stammdaten"
      description="Name, Anschrift, USt-ID oder Steuernummer und Bankverbindung der Kanzlei. Werden für XRechnung / ZUGFeRD und alle Rechnungs-Exports benötigt."
    >
      <SellerForm initial={seller} />
    </SectionCard>
  );
}
