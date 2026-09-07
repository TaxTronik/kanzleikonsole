import type { Client, GwgCheck, GwgRepresentative } from '@prisma/client';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { gwgLegalEntityRevision } from '@/server/gwg/revisions';
import { LegalEntityDetailsForm } from './legal-entity-details-form';
import {
  changeScopeLabels,
  checkStatusLabels,
  clientKindLabels,
  historyStatusBadgeClass,
} from './gwg-page-labels';
import type { GwgPageData } from './gwg-page-data';
export function GwgCheckHistory({ checkHistory }: Pick<GwgPageData, 'checkHistory'>) {
  const checkHistoryById = new Map(checkHistory.map((check) => [check.id, check]));
  return (
    <details className="card mb-6 p-5">
      <summary className="cursor-pointer text-sm font-semibold text-primary">
        Prüfverlauf ({checkHistory.length})
      </summary>
      <p className="mt-3 text-xs text-muted">
        Angezeigt wird der unveränderliche Startanlass jedes Prüfzyklus. Weitere Änderungen
        innerhalb eines laufenden Zyklus sind im Audit-Protokoll nachvollziehbar.
      </p>
      <ol className="mt-4 space-y-3">
        {checkHistory.map((historyCheck, index) => (
          <li
            key={historyCheck.id}
            className="rounded-md border border-default bg-subtle p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-primary">
                Startanlass:{' '}
                {changeScopeLabels[historyCheck.changeScope] ?? historyCheck.changeScope}
                {index === 0 ? ' · aktuell' : ''}
              </span>
              <span className={historyStatusBadgeClass(historyCheck.status)}>
                {checkStatusLabels[historyCheck.status] ?? historyCheck.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Erstellt {fmtDateTimeShort(historyCheck.createdAt)}
              {historyCheck.reviewSubmittedAt
                ? ` · eingereicht ${fmtDateTimeShort(historyCheck.reviewSubmittedAt)}`
                : ''}
              {historyCheck.verifiedAt
                ? ` · verifiziert ${fmtDateTimeShort(historyCheck.verifiedAt)}`
                : ''}
              {historyCheck.destroyedAt
                ? ` · vernichtet ${fmtDateTimeShort(historyCheck.destroyedAt)}`
                : ''}
            </p>
            {historyCheck.predecessorCheckId && (
              <p className="mt-1 text-[11px] text-muted">
                Vorgänger:{' '}
                {checkHistoryById.has(historyCheck.predecessorCheckId)
                  ? `${changeScopeLabels[checkHistoryById.get(historyCheck.predecessorCheckId)!.changeScope] ?? 'Prüfung'} vom ${fmtDateShort(checkHistoryById.get(historyCheck.predecessorCheckId)!.createdAt)}`
                  : `Prüfung ${historyCheck.predecessorCheckId.slice(0, 8)}`}
              </p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
type GwgDisplayCheck = GwgCheck & { representatives: GwgRepresentative[] };

/** Darstellung unverändert aus der Seite ausgelagert; keine neue Fachentscheidung. */
export function GwgMasterData({
  client,
  check,
}: {
  client: Client;
  check: GwgDisplayCheck | null;
}) {
  return (
    <section className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">
            Stammdaten und gesetzliche Vertretung
          </h2>
          <p className="mt-1 text-xs text-muted">
            Die wichtigsten Angaben zum Rechtsträger auf einen Blick.
          </p>
        </div>
        <span className="badge badge-gray">
          {check?.representatives.length ?? 0} gesetzliche Vertretung
          {(check?.representatives.length ?? 0) === 1 ? '' : 'en'}
        </span>
      </div>

      <GwgMasterDataFields client={client} check={check} />

      <div className="mt-5 border-t border-default pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Gesetzliche Vertreter
        </h3>
        {check?.representatives.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {check.representatives.map((representative) => (
              <li key={representative.id} className="badge badge-brand">
                {representative.fullName}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">Noch keine gesetzliche Vertretung erfasst.</p>
        )}
      </div>

      {check?.ownershipStructureNotes && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Eigentums- und Kontrollstruktur
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-secondary">
            {check.ownershipStructureNotes}
          </p>
        </div>
      )}

      {check && (
        <details className="mt-5 rounded-md border border-default bg-subtle">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">
            Stammdaten bearbeiten
          </summary>
          <div className="border-t border-default p-4">
            <LegalEntityDetailsForm
              key={gwgLegalEntityRevision(check)}
              checkId={check.id}
              clientId={client.id}
              current={{
                legalForm: check.legalForm,
                registerNumber: check.registerNumber,
                registerAuthority: check.registerAuthority,
                noRegisterEntry: check.noRegisterEntry,
                representatives: check.representatives.map((representative) => ({
                  id: representative.id,
                  fullName: representative.fullName,
                  position: representative.position,
                  linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
                })),
                ownershipStructureNotes: check.ownershipStructureNotes,
              }}
              currentRevision={gwgLegalEntityRevision(check)}
              disabled={
                check.status === 'VERIFIED' ||
                check.status === 'REJECTED' ||
                check.status === 'EXPIRED'
              }
            />
          </div>
        </details>
      )}
    </section>
  );
}

function GwgMasterDataFields({ client, check }: { client: Client; check: GwgDisplayCheck | null }) {
  const clientAddress = [
    client.street,
    [client.postalCode, client.city].filter(Boolean).join(' '),
    client.countryIso,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <dl className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <div>
        <dt className="text-xs text-muted">Name / Firma</dt>
        <dd className="text-sm font-medium text-primary">{client.name}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Mandantenart</dt>
        <dd className="text-sm font-medium text-primary">
          {clientKindLabels[client.kind] ?? client.kind}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Adresse</dt>
        <dd className="text-sm font-medium text-primary">{clientAddress || '—'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Rechtsform</dt>
        <dd className="text-sm font-medium text-primary">{check?.legalForm ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Registernummer</dt>
        <dd className="text-sm font-medium text-primary">
          {check?.noRegisterEntry ? 'Kein Registereintrag' : (check?.registerNumber ?? '—')}
        </dd>
      </div>
      <div className="md:col-span-2">
        <dt className="text-xs text-muted">Register / Registergericht</dt>
        <dd className="text-sm font-medium text-primary">
          {check?.noRegisterEntry ? 'Nicht registerpflichtig' : (check?.registerAuthority ?? '—')}
        </dd>
      </div>
    </dl>
  );
}
