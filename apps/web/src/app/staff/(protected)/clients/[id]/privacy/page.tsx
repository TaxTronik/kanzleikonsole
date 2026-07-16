// =============================================================================
// /staff/clients/[id]/privacy — Datenschutz-Einwilligungen des Mandanten.
//
// Zeigt den aktuellen Einwilligungsstand + Historie, erlaubt Erfassen/Aktuali-
// sieren und vollständigen Widerruf. Die Datenschutzhinweise (Teil A) werden
// tenant-spezifisch gerendert (Kanzlei-Angaben + Empfängerliste aus den DSGVO-
// Dienstleistern) und als Snapshot je Einwilligung eingefroren.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, Settings } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateTimeShort } from '@/lib/fmt';
import {
  parseConsent,
  countGranted,
  countRevocableGranted,
  COMMUNICATION_LABELS,
  MARKETING_LABELS,
  isBuiltinConsentOptionId,
  type ConsentSelections,
  type ConsentServiceProviderSnapshot,
} from '@/server/privacy/consent';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { readPrivacyConfigTx, isPrivacyConfigComplete } from '@/server/privacy/notice';
import { readResolvedConsentOptionsTx } from '@/server/privacy/consent-catalog';
import { NoticeView } from '@/components/notice-view';
import { ConsentEditor } from './consent-editor';
import { revokeAllConsentAction } from './actions';

function providerSnapshotLabel(provider: ConsentServiceProviderSnapshot | null): string | null {
  if (!provider) return null;
  const access =
    provider.hasDataAccess === null
      ? 'Datenzugriff historisch nicht dokumentiert'
      : provider.hasDataAccess
        ? 'Datenzugriff: ja'
        : 'Datenzugriff: nein';
  const contract = provider.contractFromDate
    ? `Vertrag ab ${provider.contractFromDate}${provider.contractToDate ? ` bis ${provider.contractToDate}` : ''}`
    : provider.contractToDate
      ? `Vertrag bis ${provider.contractToDate}`
      : 'AVV-/Vertragszeitraum nicht dokumentiert';
  return `${provider.name} · ${access} · ${contract}`;
}

function grantedConsentLabels(consent: ConsentSelections): string[] {
  const snapshots = new Map(
    consent.optionSelections.map((selection) => [selection.optionId, selection]),
  );
  const withProvider = (label: string, provider?: ConsentServiceProviderSnapshot | null) => {
    const providerLabel = providerSnapshotLabel(provider ?? null);
    return providerLabel ? `${label} · ${providerLabel}` : label;
  };

  return [
    ...(Object.keys(COMMUNICATION_LABELS) as Array<keyof typeof COMMUNICATION_LABELS>)
      .filter((key) => consent.communication[key])
      .map((key) => {
        const snapshot = snapshots.get(`communication.${key}`);
        return withProvider(
          snapshot?.labelSnapshot ?? COMMUNICATION_LABELS[key],
          snapshot?.serviceProviderSnapshot,
        );
      }),
    ...(Object.keys(MARKETING_LABELS) as Array<keyof typeof MARKETING_LABELS>)
      .filter((key) => consent.marketing[key])
      .map((key) => {
        const snapshot = snapshots.get(`marketing.${key}`);
        return withProvider(
          snapshot?.labelSnapshot ?? MARKETING_LABELS[key],
          snapshot?.serviceProviderSnapshot,
        );
      }),
    ...consent.optionSelections
      .filter((selection) => !isBuiltinConsentOptionId(selection.optionId))
      .map((selection) => withProvider(selection.labelSnapshot, selection.serviceProviderSnapshot)),
    ...consent.thirdParties.map((entry) => `Dritte: ${entry.recipient}`),
    ...consent.specialists.map((entry) => `Spezialist: ${entry.entity}`),
  ];
}

export default async function ClientPrivacyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;
  const admin = isStaffAdmin(session);

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true },
      });
      if (!client) return null;
      const [history, contacts, notice, cfg, consentOptions] = await Promise.all([
        tx.clientConsent.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.clientContact.findMany({
          where: { clientId, active: true },
          select: { id: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
        renderNoticeForTenantTx(tx, tenantId),
        readPrivacyConfigTx(tx, tenantId),
        readResolvedConsentOptionsTx(tx, tenantId),
      ]);
      return {
        client,
        history,
        contacts,
        notice,
        consentOptions,
        configComplete: isPrivacyConfigComplete(cfg),
      };
    },
  );
  if (!data) notFound();
  const { client, history, contacts, notice, consentOptions, configComplete } = data;
  const current = history[0] ?? null;
  const currentConsent = current ? parseConsent(current.consents) : null;
  const revocableConsentCount = currentConsent ? countRevocableGranted(currentConsent) : 0;
  const currentSnapshots = new Map(
    currentConsent?.optionSelections.map((selection) => [selection.optionId, selection]) ?? [],
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="h-6 w-6 text-brand-600 mt-1" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-primary mb-1">Datenschutz &amp; Einwilligungen</h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        {admin && (
          <Link href="/staff/admin/privacy" className="btn-secondary text-xs shrink-0">
            <Settings className="h-3.5 w-3.5" /> Kanzlei-Angaben
          </Link>
        )}
      </div>

      {!configComplete && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40 p-4 mb-6 text-sm text-yellow-800 dark:text-yellow-300">
          Die Kanzlei-Datenschutzangaben (verantwortliche Stelle, Aufsichtsbehörde,
          Datenschutz-Kontakt) sind noch nicht vollständig hinterlegt — der Hinweistext bleibt bis
          dahin lückenhaft.{' '}
          {admin ? (
            <Link href="/staff/admin/privacy" className="underline font-medium">
              Jetzt ergänzen
            </Link>
          ) : (
            <span>Bitte von einem Administrator ergänzen lassen.</span>
          )}
        </div>
      )}

      {/* Aktueller Stand */}
      <div className="card p-5 mb-6">
        <h2 className="text-sm font-semibold text-primary mb-2">Aktueller Einwilligungsstand</h2>
        {!current || !currentConsent ? (
          <p className="text-sm text-disabled">Noch keine Einwilligungserklärung erfasst.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-secondary">
              Zuletzt {current.isRevocation ? 'widerrufen' : 'erfasst'} am{' '}
              {fmtDateTimeShort(current.createdAt)} durch {current.signedByName}{' '}
              <span className="text-disabled">
                ({current.source === 'PORTAL' ? 'Mandant über Portal' : 'Kanzlei'})
              </span>
              {' · '}
              {countGranted(currentConsent)} Einzeleinwilligung(en) aktiv
            </p>
            <ul className="text-xs text-muted grid grid-cols-1 sm:grid-cols-2 gap-x-6">
              {(Object.keys(COMMUNICATION_LABELS) as Array<keyof typeof COMMUNICATION_LABELS>)
                .filter((k) => currentConsent.communication[k])
                .map((k) => {
                  const snapshot = currentSnapshots.get(`communication.${k}`);
                  return (
                    <li key={`c-${k}`}>
                      ✓ {snapshot?.labelSnapshot ?? COMMUNICATION_LABELS[k]}
                      {providerSnapshotLabel(snapshot?.serviceProviderSnapshot ?? null)
                        ? ` · ${providerSnapshotLabel(snapshot?.serviceProviderSnapshot ?? null)}`
                        : ''}
                    </li>
                  );
                })}
              {(Object.keys(MARKETING_LABELS) as Array<keyof typeof MARKETING_LABELS>)
                .filter((k) => currentConsent.marketing[k])
                .map((k) => {
                  const snapshot = currentSnapshots.get(`marketing.${k}`);
                  return (
                    <li key={`m-${k}`}>
                      ✓ {snapshot?.labelSnapshot ?? MARKETING_LABELS[k]}
                      {providerSnapshotLabel(snapshot?.serviceProviderSnapshot ?? null)
                        ? ` · ${providerSnapshotLabel(snapshot?.serviceProviderSnapshot ?? null)}`
                        : ''}
                    </li>
                  );
                })}
              {currentConsent.optionSelections
                .filter((selection) => !isBuiltinConsentOptionId(selection.optionId))
                .map((selection) => (
                  <li key={`o-${selection.optionId}`}>
                    ✓ {selection.labelSnapshot}
                    {providerSnapshotLabel(selection.serviceProviderSnapshot)
                      ? ` · ${providerSnapshotLabel(selection.serviceProviderSnapshot)}`
                      : ''}
                  </li>
                ))}
              {currentConsent.thirdParties.map((t, i) => (
                <li key={`t-${i}`}>✓ Dritte: {t.recipient}</li>
              ))}
              {currentConsent.specialists.map((s, i) => (
                <li key={`s-${i}`}>✓ Spezialist: {s.entity}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Erfassen / Aktualisieren */}
      <h2 className="text-sm font-semibold text-primary mb-2">
        {current ? 'Einwilligungsstand aktualisieren' : 'Einwilligungen erfassen'}
      </h2>
      <p className="text-xs text-muted mb-3">
        Speichern legt einen neuen, unveränderlichen Nachweis-Snapshot an (der vorige bleibt in der
        Historie). Nicht angekreuzte Optionen gelten als nicht erteilt.
      </p>
      <ConsentEditor
        clientId={clientId}
        initial={currentConsent ?? undefined}
        contacts={contacts}
        options={consentOptions}
      />

      {/* Widerruf */}
      {current && !current.isRevocation && revocableConsentCount > 0 && (
        <form action={revokeAllConsentAction} className="card p-5 mt-6 border-l-4 border-l-red-400">
          <input type="hidden" name="clientId" value={clientId} />
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">
            Alle freiwilligen Einwilligungen widerrufen
          </h3>
          <p className="text-xs text-muted mb-3">
            Wirkung für die Zukunft (Art. 7 Abs. 3 DSGVO). Die mandatsnotwendige Verarbeitung bleibt
            auf gesetzlicher/vertraglicher Grundlage zulässig.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              name="signedByName"
              required
              maxLength={300}
              placeholder="Name der widerrufenden Person *"
              className="input text-sm sm:flex-1"
            />
            <input
              name="note"
              maxLength={2000}
              placeholder="Grund (optional)"
              className="input text-sm sm:flex-1"
            />
            <button
              type="submit"
              className="btn-primary !bg-red-600 hover:!bg-red-700 text-sm shrink-0"
            >
              Widerrufen
            </button>
          </div>
        </form>
      )}

      {/* Historie */}
      {history.length > 1 && (
        <>
          <h2 className="text-sm font-semibold text-primary mt-8 mb-2">Historie</h2>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-raised border-b border-default">
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                    Zeitpunkt
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                    Art
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                    Person
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                    Quelle
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                    Aktiv
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {history.map((h) => {
                  const consent = parseConsent(h.consents);
                  const labels = grantedConsentLabels(consent);
                  return (
                    <tr key={h.id}>
                      <td className="px-4 py-2 text-secondary">{fmtDateTimeShort(h.createdAt)}</td>
                      <td className="px-4 py-2">
                        {h.isRevocation ? (
                          <span className="badge badge-red">Widerruf</span>
                        ) : (
                          <span className="badge badge-green">Erteilung</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-secondary">{h.signedByName}</td>
                      <td className="px-4 py-2 text-secondary">
                        {h.source === 'PORTAL' ? 'Portal' : 'Kanzlei'}
                      </td>
                      <td className="px-4 py-2 text-muted">
                        {labels.length === 0 ? (
                          countGranted(consent)
                        ) : (
                          <details>
                            <summary className="cursor-pointer whitespace-nowrap">
                              {countGranted(consent)} · Details
                            </summary>
                            <ul className="mt-1 min-w-56 space-y-0.5 text-xs">
                              {labels.map((label, index) => (
                                <li key={`${h.id}-${index}`}>✓ {label}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Hinweistext-Vorschau */}
      <details className="mt-8">
        <summary className="text-sm font-medium text-brand-700 dark:text-brand-500 cursor-pointer">
          Datenschutzhinweise (Teil A) — aktuelle Fassung ansehen (Version {notice.version})
        </summary>
        <div className="mt-3 bg-surface-raised rounded-md p-4 border border-default overflow-x-auto">
          <NoticeView body={notice.body} />
        </div>
      </details>
    </div>
  );
}
