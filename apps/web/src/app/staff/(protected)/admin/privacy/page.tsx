// =============================================================================
// /staff/admin/privacy — Kanzlei-Datenschutzangaben (füllen die Platzhalter der
// Datenschutzhinweise). Admin/Partner-only.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { readPrivacyConfig, PRIVACY_NOTICE_VERSION } from '@/server/privacy/notice';
import { readResolvedConsentOptionsTx } from '@/server/privacy/consent-catalog';
import { defaultConsentOptionsCatalog, type ResolvedConsentOption } from '@/server/privacy/consent';
import { PrivacyConfigForm } from './config-form';
import { ConsentOptionsEditor } from './consent-options-editor';

export default async function AdminPrivacyPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [config, consentData] = await Promise.all([
    readPrivacyConfig(ctx),
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
    <div className="p-8 max-w-4xl">
      <Link href="/staff/admin" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="h-6 w-6 text-brand-600 mt-1" />
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Kanzlei-Datenschutzangaben</h1>
          <p className="text-muted text-sm">
            Diese Angaben füllen die Datenschutzhinweise (Teil A, Standardtext Version{' '}
            {PRIVACY_NOTICE_VERSION}), die Mandanten bei der Einwilligung angezeigt und als Nachweis
            eingefroren werden. Die Empfängerliste (Abschnitt 5) stammt automatisch aus{' '}
            <Link href="/staff/service-providers" className="underline">
              Dienstleister (AVV)
            </Link>
            .
          </p>
        </div>
      </div>
      <PrivacyConfigForm initial={config} />
      <ConsentOptionsEditor
        initial={consentData.options}
        providers={consentData.providers}
        repairRequired={consentData.catalogRepairRequired}
        revision={consentData.catalogRevision}
      />
    </div>
  );
}
