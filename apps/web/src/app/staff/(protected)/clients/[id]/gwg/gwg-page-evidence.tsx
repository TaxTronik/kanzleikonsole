import { AlertTriangle, FileCheck, ChevronRight } from 'lucide-react';
import { Stage } from '@/components/stage';
import { fmtDateShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';
import { AddIdDocumentForm } from './add-id-doc-form';
import { RemoveEvidenceLinkButton } from './remove-evidence-link-button';
import { EvidenceFormToggle } from './evidence-form-toggle';
import type { IdentityReviewGroup } from './identity-document-review';
import { idTypeLabels, isPersonalIdType, ENTITY_TYPE_BLOCKS } from './gwg-page-labels';
import type { GwgPageModel } from './gwg-page-model';
export function GwgEntityEvidence({ model }: { model: GwgPageModel }) {
  const {
    client,
    check,
    gwgSteps,
    entityDocuments,
    supersededEntityDocuments,
    selectableDocuments,
    editable: editableCheck,
  } = model;
  if (!check || model.destroyed) return null;
  return (
    <Stage
      state={gwgSteps[1]!.state}
      title="Rechtsträger- und Registernachweise"
      sub="Register-, Gründungs- und Vertretungsnachweise je Dokumenttyp."
      badge={<span className="badge badge-gray">{(entityDocuments ?? []).length} Nachweise</span>}
    >
      {/* Jeder Nachweistyp startet eingeklappt und besitzt seine
                      eigene Upload-Fläche. */}
      <div>
        <p className="mb-4 text-xs text-muted">
          Register-/Gründungsnachweis, gegebenenfalls Transparenzregister und Vertretungsvollmachten
          — ohne Ausweisnummer oder Gültigkeitsdatum.
        </p>
        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
          {ENTITY_TYPE_BLOCKS.map((block) => {
            const docs = (entityDocuments ?? []).filter((d) => d.type === block.value);
            const oldDocs = (supersededEntityDocuments ?? []).filter(
              (document) => document.type === block.value,
            );
            return (
              <details key={block.value} className="details-box">
                <summary>
                  <ChevronRight className="h-4 w-4" />
                  <span className="min-w-0 flex-1 text-[13px] font-semibold text-primary">
                    {block.label}
                  </span>
                  <span className="badge badge-gray">{docs.length}</span>
                </summary>
                <div className="details-body pt-2">
                  <GwgDocumentList
                    documents={docs}
                    checkId={check.id}
                    clientId={client.id}
                    editable={editableCheck}
                  />
                  {oldDocs.length > 0 && (
                    <details className="mb-4 rounded-md border border-default bg-subtle">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">
                        Alte Nachweise ({oldDocs.length})
                      </summary>
                      <div className="border-t border-default p-3">
                        <GwgDocumentList documents={oldDocs} />
                      </div>
                    </details>
                  )}
                  {editableCheck && (
                    <EvidenceFormToggle
                      label={docs.length > 0 ? 'Nachweis ersetzen' : 'Nachweis hinzufügen'}
                    >
                      <AddIdDocumentForm
                        checkId={check.id}
                        clientId={client.id}
                        clientDocuments={selectableDocuments}
                        variant="entity"
                        defaultType={block.value}
                        lockType
                        replacement={docs.length > 0 ? { mode: 'type' } : undefined}
                      />
                    </EvidenceFormToggle>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </Stage>
  );
}
interface DisplayGwgDocument {
  id: string;
  type: string;
  ownerName: string;
  number: string | null;
  expiryDate: Date | null;
  document: { id: string; title: string } | null;
}

export function HistoricalIdentityGroups({
  groups,
  nested = true,
}: {
  groups: IdentityReviewGroup[];
  nested?: boolean;
}) {
  const content = (
    <div className="space-y-3">
      {groups.map((group) => {
        const first = group.documents[0]!;
        return (
          <div
            key={group.documentSetId}
            className="rounded-md border border-default bg-surface p-3"
          >
            <p className="text-xs font-semibold text-primary">
              {idTypeLabels[first.type]} · {first.ownerName}
            </p>
            <p className="mt-1 text-xs text-muted">
              {first.number ? `Nr. ${first.number} · ` : ''}
              {first.expiryDate
                ? `gültig bis ${fmtDateShort(new Date(first.expiryDate))}`
                : 'ohne Gültigkeitsdatum'}
            </p>
            <div className="mt-2 space-y-1">
              {group.documents.map((entry) =>
                entry.document ? (
                  <div key={entry.id} className="flex items-center gap-1 text-xs text-muted">
                    <span>{entry.document.title}</span>
                    <DocumentPreviewButton
                      documentId={entry.document.id}
                      documentTitle={entry.document.title}
                    />
                  </div>
                ) : (
                  <p key={entry.id} className="text-xs text-red-700">
                    Datei nicht verfügbar
                  </p>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
  if (!nested) return content;
  return (
    <details className="rounded-md border border-default bg-subtle">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">
        Alte Ausweise ({groups.length})
      </summary>
      <div className="border-t border-default p-3">{content}</div>
    </details>
  );
}

function GwgDocumentList({
  documents,
  checkId,
  clientId,
  editable = false,
}: {
  documents: DisplayGwgDocument[];
  checkId?: string;
  clientId?: string;
  editable?: boolean;
}) {
  if (documents.length === 0) {
    return <p className="text-xs text-disabled mb-4">Noch kein Nachweis zugeordnet.</p>;
  }

  return (
    <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
      {documents.map((document) => (
        <li key={document.id} className="px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            {document.document ? (
              <FileCheck className="h-4 w-4 text-green-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-red-600" />
            )}
            <span className="font-medium text-primary">
              {idTypeLabels[document.type] ?? document.type}
            </span>
            {document.expiryDate && document.expiryDate < new Date() && (
              <span className="badge-red">abgelaufen</span>
            )}
            {!document.document && <span className="badge-red">Datei nicht verfügbar</span>}
            {editable && checkId && clientId && (
              <RemoveEvidenceLinkButton
                checkId={checkId}
                clientId={clientId}
                gwgIdDocumentId={document.id}
              />
            )}
          </div>
          {isPersonalIdType(document.type) && (
            <p className="text-xs text-muted ml-6">
              {document.ownerName}
              {document.number ? ` · Nr. ${document.number}` : ''}
              {document.expiryDate ? ` · gültig bis ${fmtDateShort(document.expiryDate)}` : ''}
            </p>
          )}
          {document.document && (
            <div className="flex items-center gap-1 ml-6 mt-1">
              <span className="text-xs text-muted">{document.document.title}</span>
              <DocumentPreviewButton
                documentId={document.document.id}
                documentTitle={document.document.title}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
