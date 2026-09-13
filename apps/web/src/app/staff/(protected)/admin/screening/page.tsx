import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { assertModuleEnabled } from '@/server/settings/modules';
import { RefreshScreeningForm } from './refresh-form';
import { ScreeningSourceState } from './source-state';
export default async function ScreeningAdminPage() {
  const session = await requireStaffPage({ admin: true });
  const ctx: TenantContext = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF',
  };
  await assertModuleEnabled(ctx, 'sanctionsScreening');
  const state = await withTenantContext(ctx, (tx) =>
    tx.sanctionsSourceState.findUnique({
      where: { tenantId: ctx.tenantId },
      include: {
        snapshot: {
          select: {
            sha256: true,
            sourceVersion: true,
            publishedAt: true,
            entryCount: true,
            importedAt: true,
          },
        },
      },
    }),
  );
  return (
    <div className="max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="page-title">Lokale EU-Sanktionsquelle</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Offizielle konsolidierte EU-Liste, XML 1.1. Der Abruf sendet keine Mandanten- oder
          Personendaten. Abgleiche finden lokal statt. Keine OpenSanctions-Daten und keine
          kostenpflichtige PEP-Datenbank.
        </p>
        <p className="mt-3 text-sm">
          <a
            className="text-brand-700 underline underline-offset-2"
            href="https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en"
            target="_blank"
            rel="noopener noreferrer"
          >
            Offizieller EU-Datenkatalog und Nutzungsinformationen
          </a>
        </p>
      </div>
      <section className="card overflow-hidden" aria-labelledby="screening-source-heading">
        <div className="card-header">
          <h2 id="screening-source-heading" className="font-semibold text-primary">
            Quellenstand
          </h2>
        </div>
        <ScreeningSourceState state={state} />
        <div className="border-t border-default px-5 py-4">
          <RefreshScreeningForm />
        </div>
      </section>
      <section
        className="card space-y-3 p-5 text-sm leading-relaxed text-secondary"
        aria-labelledby="screening-operation-heading"
      >
        <h2 id="screening-operation-heading" className="font-semibold text-primary">
          Abruf und Folgeprüfungen
        </h2>
        <p>
          Nach einem Abruffehler bleibt der letzte gültige Bestand erhalten; neue manuelle
          EU-Prüfläufe sind bei Fehler oder über 48 Stunden seit erfolgreicher Prüfung gesperrt.
          Änderungen führen im täglichen Worker zu neuen Prüfläufen und internen Hinweisen. Eine
          bestehende GwG-Freigabe wird nie automatisch geändert.
        </p>
      </section>
      <section
        className="rounded-lg border border-default bg-surface-raised p-5 text-sm leading-relaxed text-secondary"
        aria-labelledby="screening-activation-heading"
      >
        <h2 id="screening-activation-heading" className="mb-2 font-semibold text-primary">
          Vor der Aktivierung
        </h2>
        <p>
          Vor Aktivierung: fachliche Freigabe des Screeningverfahrens, Zuständigkeiten für Treffer
          und ein Aufbewahrungs-/Löschkonzept für die zusätzlichen Nachweise festlegen. Der
          allgemeine GwG-Löschlauf erfasst diese neuen Tabellen noch nicht.
        </p>
      </section>
    </div>
  );
}
