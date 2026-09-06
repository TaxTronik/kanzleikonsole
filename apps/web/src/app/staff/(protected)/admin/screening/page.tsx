import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { assertModuleEnabled } from '@/server/settings/modules';
import { RefreshScreeningForm } from './refresh-form';
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
    <main className="p-8 max-w-4xl space-y-5">
      <h1 className="text-2xl font-bold">Lokale EU-Sanktionsquelle</h1>
      <p>
        Offizielle konsolidierte EU-Liste, XML 1.1. Der Abruf sendet keine Mandanten- oder
        Personendaten. Abgleiche finden lokal statt. Keine OpenSanctions-Daten und keine
        kostenpflichtige PEP-Datenbank.
      </p>
      <p>
        <a
          className="underline"
          href="https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en"
          target="_blank"
          rel="noopener noreferrer"
        >
          Offizieller EU-Datenkatalog und Nutzungsinformationen
        </a>
      </p>
      <pre className="whitespace-pre-wrap break-all rounded border p-4 text-sm">
        {JSON.stringify(state, null, 2)}
      </pre>
      <RefreshScreeningForm />
      <p>
        Nach einem Abruffehler bleibt der letzte gültige Bestand erhalten; neue manuelle
        EU-Prüfläufe sind bei Fehler oder über 48 Stunden seit erfolgreicher Prüfung gesperrt.
        Änderungen führen im täglichen Worker zu neuen Prüfläufen und internen Hinweisen. Eine
        bestehende GwG-Freigabe wird nie automatisch geändert.
      </p>
      <p>
        Vor Aktivierung: fachliche Freigabe des Screeningverfahrens, Zuständigkeiten für Treffer und
        ein Aufbewahrungs-/Löschkonzept für die zusätzlichen Nachweise festlegen. Der allgemeine
        GwG-Löschlauf erfasst diese neuen Tabellen noch nicht.
      </p>
    </main>
  );
}
