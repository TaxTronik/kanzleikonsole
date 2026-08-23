import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { readBranding } from '@/server/settings/branding';
import { readLetterhead } from '@/server/settings/letterhead';
import { BrandingForm } from '../branding-form';
import { LetterheadForm } from '../letterhead-form';
import { SectionCard } from '../section-card';

export default async function BrandingSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [branding, letterhead] = await Promise.all([readBranding(ctx), readLetterhead(ctx)]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Erscheinungsbild"
        description="Logo, Anzeigename und Akzentfarbe der Kanzlei. Wirkt in Mitarbeiter- und Mandanten-Oberfläche."
      >
        <BrandingForm initial={branding} />
      </SectionCard>

      <SectionCard
        title="Briefkopf"
        description="Wird bei der erstmaligen Erzeugung von In-App-Rechnungs-PDFs verwendet; bestehende Archive und Uploads bleiben unverändert."
      >
        <LetterheadForm initial={letterhead} />
      </SectionCard>

      <SectionCard
        title="Rechtliche Hinweise"
        description="Impressum und Datenschutzerklärung werden gemeinsam mit den übrigen DSGVO-Einstellungen zentral gepflegt."
      >
        <Link
          href="/staff/admin/privacy#oeffentliche-datenschutzerklaerung"
          className="btn-secondary"
        >
          Datenschutz-Zentrale öffnen
        </Link>
      </SectionCard>
    </div>
  );
}
