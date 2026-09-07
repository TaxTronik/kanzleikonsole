import { ChevronRight } from 'lucide-react';
import { Stage } from '@/components/stage';
import { gwgLegalEntityRevision } from '@/server/gwg/revisions';
import { NewGwgPersonForm } from './new-gwg-person-form';
import { PersonGeneralForm } from './person-general-form';
import { PersonRolesPanel } from './person-roles-panel';
import { IdentityDocumentReview } from './identity-document-review';
import { HistoricalIdentityGroups } from './gwg-page-evidence';
import {
  ownerRoleValue,
  personAusweisBadgeClass,
  personAusweisLabel,
  type GwgPageModel,
} from './gwg-page-model';
export function GwgPersons({ model, canVerify }: { model: GwgPageModel; canVerify: boolean }) {
  const {
    client,
    check,
    gwgSteps,
    persons,
    subjectOptions,
    selectableDocuments,
    unassignedGroups,
    unassignedOldGroups,
    editable: editableCheck,
  } = model;
  if (!check || model.destroyed) return null;
  return (
    <div className="mb-6">
      {/* Personen-zentriert: jede Person mit ihren Nachweisen direkt
                unter der Einladung. */}
      <Stage
        state={gwgSteps[1]!.state}
        title="Personen"
        sub="Relevante Personen, ihre Rollen und die zugehörigen Identitätsnachweise."
        badge={
          <span className="badge badge-gray">
            {persons.length} {persons.length === 1 ? 'Person' : 'Personen'}
          </span>
        }
      >
        {editableCheck && (client.kind === 'JURPERS' || client.kind === 'PERSGES') && (
          <NewGwgPersonForm checkId={check.id} clientId={client.id} />
        )}
        {persons.length === 0 && <p className="text-sm text-muted">Noch keine Personen erfasst.</p>}
        <div className="space-y-3">
          {persons.map((person) => (
            <details
              key={person.key}
              className="details-box"
              open={person.ausweis !== 'bestaetigt'}
            >
              <summary>
                <ChevronRight className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                  {person.name}
                </span>
                {person.roles.map((role) => (
                  <span key={role} className="badge badge-brand">
                    {role}
                  </span>
                ))}
                {person.isPep && <span className="badge badge-red">PEP</span>}
                <span className={personAusweisBadgeClass(person.ausweis)}>
                  {personAusweisLabel(person.ausweis)}
                </span>
              </summary>
              <div className="details-body space-y-4 pt-2">
                <PersonGeneralForm
                  ownerId={person.owner?.id ?? null}
                  representativeId={person.representative?.id ?? null}
                  checkId={check.id}
                  clientId={client.id}
                  value={person.general}
                  revision={person.generalRevision}
                  disabled={!editableCheck}
                />
                <IdentityDocumentReview
                  checkId={check.id}
                  clientId={client.id}
                  groups={person.groups}
                  subjectOptions={subjectOptions}
                  clientDocuments={selectableDocuments}
                  defaultSubjectKey={person.key}
                  historicalEvidence={
                    person.oldGroups.length > 0 ? (
                      <HistoricalIdentityGroups groups={person.oldGroups} />
                    ) : undefined
                  }
                  grandfathered={
                    check.status === 'VERIFIED' && check.identityAssignmentRequired === false
                  }
                  disabled={
                    check.status === 'VERIFIED' ||
                    check.status === 'REJECTED' ||
                    check.status === 'EXPIRED'
                  }
                  reviewMode={check.status === 'IN_REVIEW' && canVerify}
                />
                <PersonRolesPanel
                  key={`${person.key}:${gwgLegalEntityRevision(check)}`}
                  checkId={check.id}
                  clientId={client.id}
                  personName={person.name}
                  roleLabels={person.roles.map((role) =>
                    role === 'Vertreter'
                      ? 'Gesetzliche Vertretung'
                      : role.startsWith('WB')
                        ? role.replace('WB', 'Wirtschaftlich berechtigt')
                        : role,
                  )}
                  owner={ownerRoleValue(person.owner)}
                  representativeId={person.representative?.id ?? null}
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
                    client.kind === 'NATPERS' ||
                    check.status === 'VERIFIED' ||
                    check.status === 'REJECTED' ||
                    check.status === 'EXPIRED'
                  }
                />
              </div>
            </details>
          ))}
        </div>

        {unassignedGroups.length > 0 && (
          <details className="details-box mt-3">
            <summary>
              <ChevronRight className="h-4 w-4" />
              Nicht zugeordnete Nachweise
              <span className="badge badge-yellow">{unassignedGroups.length}</span>
            </summary>
            <div className="details-body">
              <IdentityDocumentReview
                checkId={check.id}
                clientId={client.id}
                groups={unassignedGroups}
                subjectOptions={subjectOptions}
                clientDocuments={selectableDocuments}
                grandfathered={
                  check.status === 'VERIFIED' && check.identityAssignmentRequired === false
                }
                disabled={
                  check.status === 'VERIFIED' ||
                  check.status === 'REJECTED' ||
                  check.status === 'EXPIRED'
                }
                reviewMode={check.status === 'IN_REVIEW' && canVerify}
              />
            </div>
          </details>
        )}

        {unassignedOldGroups.length > 0 && (
          <details className="details-box mt-3">
            <summary>
              <ChevronRight className="h-4 w-4" />
              Alte, nicht zugeordnete Nachweise
              <span className="badge badge-gray">{unassignedOldGroups.length}</span>
            </summary>
            <div className="details-body">
              <HistoricalIdentityGroups groups={unassignedOldGroups} nested={false} />
            </div>
          </details>
        )}
      </Stage>
    </div>
  );
}
