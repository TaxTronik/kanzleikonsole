import Link from 'next/link';
import { staffAuth } from '@/server/auth/staff';
import { readBranding } from '@/server/settings/branding';
import { readLetterhead } from '@/server/settings/letterhead';
import { BrandingForm } from '../branding-form';
import { LetterheadForm } from '../letterhead-form';
import { SectionCard } from '../section-card';
import { redirect } from 'next/navigation';

export default async function BrandingSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
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
        description="Wird in allen ausgehenden PDFs verwendet (Vollmachten, Rechnungen, Bescheinigungen)."
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
