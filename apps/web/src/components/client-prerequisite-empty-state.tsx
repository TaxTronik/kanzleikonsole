import Link from 'next/link';
import { UsersRound } from 'lucide-react';

/** Only describe the caller's eligible selection, never the tenant's total stock. */
export function ClientPrerequisiteEmptyState({ canCreateClient }: { canCreateClient: boolean }) {
  return (
    <section className="card p-5 sm:p-6 space-y-4" aria-labelledby="client-prerequisite-title">
      <div className="flex items-start gap-3">
        <UsersRound className="h-5 w-5 shrink-0 text-muted mt-0.5" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <h2 id="client-prerequisite-title" className="font-semibold text-primary">
            Kein auswählbarer Mandant
          </h2>
          <p className="text-sm text-muted">
            Für diesen Schritt steht Ihnen derzeit kein aktiver Mandant zur Verfügung. Prüfen Sie
            den Status in Ihrer Mandantenliste. Bei Fragen zur Freigabe oder zu Ihrem Zugriff hilft
            die Kanzleiverwaltung.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link className="btn-primary" href="/staff/clients">
          Mandantenliste öffnen
        </Link>
        {canCreateClient && (
          <Link className="btn-secondary" href="/staff/clients/onboarding/new">
            Mandant aufnehmen
          </Link>
        )}
      </div>
    </section>
  );
}
