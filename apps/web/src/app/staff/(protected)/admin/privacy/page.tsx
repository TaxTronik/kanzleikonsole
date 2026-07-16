// =============================================================================
// /staff/admin/privacy — Kanzlei-Datenschutzangaben (füllen die Platzhalter der
// Datenschutzhinweise). Admin/Partner-only.
// =============================================================================

import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  FileText,
  Scale,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import {
  isPrivacyConfigComplete,
  readPrivacyConfig,
  PRIVACY_NOTICE_VERSION,
} from '@/server/privacy/notice';
import { readResolvedConsentOptionsTx } from '@/server/privacy/consent-catalog';
import { defaultConsentOptionsCatalog, type ResolvedConsentOption } from '@/server/privacy/consent';
import { readLegal } from '@/server/settings/legal';
import { LegalForm } from '../settings/legal-form';
import { PrivacyConfigForm } from './config-form';
import { ConsentOptionsEditor } from './consent-options-editor';

export default async function AdminPrivacyPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [config, legal, consentData] = await Promise.all([
    readPrivacyConfig(ctx),
    readLegal(ctx),
    withTenantContext(ctx, async (tx) => {
      const [providers, catalogSetting] = await Promise.all([
        tx.serviceProvider.findMany({
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            category: true,
            hasDataAccess: true,
            contractFromDate: true,
            contractToDate: true,
          },
        }),
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId, key: 'privacy.consent_options' } },
          select: { updatedAt: true },
        }),
      ]);
      let options: ResolvedConsentOption[];
      let catalogRepairRequired = false;
      try {
        options = await readResolvedConsentOptionsTx(tx, tenantId);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('Einwilligungskatalog der Kanzlei ist ungültig')
        ) {
          throw error;
        }
        catalogRepairRequired = true;
        options = defaultConsentOptionsCatalog().options.map((option) => ({
          ...option,
          serviceProvider: null,
          providerMissing: false,
        }));
      }
      return {
        options,
        catalogRepairRequired,
        catalogRevision: catalogSetting?.updatedAt.toISOString() ?? 'missing',
        providers: providers.map((provider) => ({
          ...provider,
          contractFromDate: provider.contractFromDate?.toISOString().slice(0, 10) ?? null,
          contractToDate: provider.contractToDate?.toISOString().slice(0, 10) ?? null,
        })),
      };
    }),
  ]);

  return (
    <div className="p-8 max-w-6xl">
      <Link href="/staff/admin" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="h-6 w-6 text-brand-600 mt-1" />
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Datenschutz-Zentrale</h1>
          <p className="text-muted text-sm">
            Kanzlei-Hinweise, Datenschutz-Auswahl und Bestätigungen, Dienstleister (AVV),
            öffentliche Datenschutzerklärung und Betroffenenrechte an einem Ort.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-8">
        <a href="#kanzlei-hinweise" className="card p-4 group">
          <FileText className="h-5 w-5 text-brand-600 mb-3" />
          <p className="text-sm font-semibold text-primary">Hinweise &amp; Datenschutz-Auswahl</p>
          <p className="text-xs text-muted mt-1">
            {isPrivacyConfigComplete(config) ? 'Kanzlei-Angaben vollständig' : 'Angaben ergänzen'}
          </p>
          <ArrowRight className="h-4 w-4 text-disabled group-hover:text-brand-600 mt-3" />
        </a>
        <Link href="/staff/service-providers" className="card p-4 group">
          <Building2 className="h-5 w-5 text-brand-600 mb-3" />
          <p className="text-sm font-semibold text-primary">Dienstleister (AVV)</p>
          <p className="text-xs text-muted mt-1">
            {consentData.providers.length} Dienstleister erfasst
          </p>
          <ArrowRight className="h-4 w-4 text-disabled group-hover:text-brand-600 mt-3" />
        </Link>
        <Link href="/staff/admin/dsgvo" className="card p-4 group">
          <Scale className="h-5 w-5 text-brand-600 mb-3" />
          <p className="text-sm font-semibold text-primary">DSGVO-Anfragen</p>
          <p className="text-xs text-muted mt-1">Betroffenenrechte bearbeiten</p>
          <ArrowRight className="h-4 w-4 text-disabled group-hover:text-brand-600 mt-3" />
        </Link>
        <Link href="/staff/admin/dsgvo-retention" className="card p-4 group">
          <Trash2 className="h-5 w-5 text-brand-600 mb-3" />
          <p className="text-sm font-semibold text-primary">Löschung &amp; Aufbewahrung</p>
          <p className="text-xs text-muted mt-1">Anonymisierung nach Art. 17</p>
          <ArrowRight className="h-4 w-4 text-disabled group-hover:text-brand-600 mt-3" />
        </Link>
      </div>

      <section id="kanzlei-hinweise" className="scroll-mt-20">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-primary">Kanzlei-Datenschutzhinweise</h2>
          <p className="text-sm text-muted mt-1">
            Diese Angaben füllen den Standardtext Version {PRIVACY_NOTICE_VERSION}, den Mandanten
            sehen und der mit jeder Erklärung unveränderlich nachgewiesen wird. Empfänger stammen
            automatisch aus dem Dienstleisterverzeichnis.
          </p>
        </div>
        <PrivacyConfigForm initial={config} />
      </section>

      <section id="oeffentliche-datenschutzerklaerung" className="scroll-mt-20 mt-8">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-primary">
            Öffentliche Datenschutzerklärung &amp; Impressum
          </h2>
          <p className="text-sm text-muted mt-1">
            Die Links erscheinen auf den Login-Seiten für Mitarbeiter und Mandanten.
          </p>
        </div>
        <div className="card p-6">
          <LegalForm initial={legal} />
        </div>
      </section>

      <section id="einwilligungsoptionen" className="scroll-mt-20">
        <ConsentOptionsEditor
          initial={consentData.options}
          providers={consentData.providers}
          repairRequired={consentData.catalogRepairRequired}
          revision={consentData.catalogRevision}
        />
      </section>
    </div>
  );
}
