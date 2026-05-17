import { staffAuth } from '@/server/auth/staff';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { SellerForm } from '../seller-form';
import { SectionCard } from '../section-card';
import { redirect } from 'next/navigation';

export default async function SellerSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const seller = await readSellerInfo({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <SectionCard
      title="Kanzlei-Stammdaten"
      description="Name, Anschrift, USt-ID und Bankverbindung der Kanzlei. Werden für XRechnung / ZUGFeRD und alle Rechnungs-Exports benötigt."
    >
      <SellerForm initial={seller} />
    </SectionCard>
  );
}
