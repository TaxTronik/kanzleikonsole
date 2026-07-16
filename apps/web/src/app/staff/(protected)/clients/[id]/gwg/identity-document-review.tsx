'use client';

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Download, FileCheck, FileSearch, Loader2, X } from 'lucide-react';
import {
  extendIdentityDocumentSetAction,
  updateIdDocumentsAction,
  type ActionResult,
} from './actions';
import {
  identitySubjectRoleLabel,
  selectableIdentitySubjectOptions,
  type IdentitySubjectOption,
} from '@/server/gwg/identity-subject';
import { DocumentPreviewButton } from '@/components/document-preview';
import { DocumentUploadButton } from '@/components/document-upload-button';
import {
  useUnlinkedGwgDocumentSearch,
  type SelectableGwgDocument,
} from './use-gwg-document-search';
import { useGwgIdentitySubjects } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';
import {
  useIdentityReviewState,
  type IdentityReviewLocalState,
  type IdentityReviewSavedState,
} from './use-identity-review-state';

export {
  applyIdentityReviewSave,
  reconcileIdentityReviewServerState,
} from './use-identity-review-state';
export type {
  IdentityReviewEditableFields,
  IdentityReviewLocalState,
  IdentityReviewSavedState,
} from './use-identity-review-state';

export interface IdentityReviewDocument {
  id: string;
  gwgCheckId: string;
  documentSetId: string;
  documentId: string | null;
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  verifiedAt: string | null;
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
  identityAssignmentConfirmedAt: string | null;
  identityAssignmentConfirmedBy: string | null;
  notes: string | null;
  document: { id: string; title: string; createdAt: string } | null;
}

export interface IdentityReviewGroup {
  key: string;
  documentSetId: string;
  documents: IdentityReviewDocument[];
  subjectKey: string | null;
  revision: string;
}

interface IdentitySetFileCandidate {
  key: string;
  sourceDocumentSetId: string | null;
  documents: SelectableGwgDocument[];
}

const typeLabels = {
  PERSONALAUSWEIS: 'Personalausweis',
  REISEPASS: 'Reisepass',
} as const;

function InlineEvidence({
  document,
  label,
  active,
}: {
  document: NonNullable<IdentityReviewDocument['document']>;
  label: string | null;
  active: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inViewport, setInViewport] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!active || !element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active || !inViewport || url || error) return;
    let cancelled = false;
    setLoading(true);
    void fetch(`/api/staff/documents/${document.id}/preview-url`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { url: string; mimeType: string };
      })
      .then((result) => {
        if (cancelled) return;
        setUrl(result.url);
        setMimeType(result.mimeType);
      })
      .catch(() => {
        if (!cancelled) setError('Vorschau konnte nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, document.id, error, inViewport, url]);

  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf' || mimeType?.endsWith('pdf');

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-md border border-default bg-gray-100 dark:bg-gray-950"
    >
      <div className="flex items-center justify-between border-b border-default bg-surface px-3 py-2">
        <div className="min-w-0">
          {label && <p className="text-[11px] font-semibold text-brand-700">{label}</p>}
          <p className="truncate text-xs font-medium text-primary">{document.title}</p>
        </div>
        <a
          href={`/api/staff/documents/${document.id}/download`}
          className="p-1 text-muted hover:text-primary"
          title="Dokument herunterladen"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
      <div className="flex min-h-72 items-center justify-center lg:min-h-96">
        {loading && <Loader2 className="h-6 w-6 animate-spin text-disabled" />}
        {error && (
          <div className="space-y-2 p-4 text-center text-xs text-red-700">
            <p>{error}</p>
            <button type="button" className="btn-secondary text-xs" onClick={() => setError(null)}>
              Vorschau erneut laden
            </button>
          </div>
        )}
        {url && isImage && (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated, short-lived evidence preview URL
          <img
            src={url}
            alt={document.title}
            loading="lazy"
            className="max-h-[65vh] w-full object-contain"
            onError={() => {
              setUrl(null);
              setError('Die Vorschau-URL ist abgelaufen oder nicht mehr erreichbar.');
            }}
          />
        )}
        {url && isPdf && (
          <iframe src={url} title={document.title} className="h-[65vh] min-h-96 w-full border-0" />
        )}
        {url && !isImage && !isPdf && (
          <a
            href={`/api/staff/documents/${document.id}/download`}
            className="btn-secondary text-xs"
          >
            Vorschau nicht verfügbar — herunterladen
          </a>
        )}
      </div>
    </div>
  );
}

function IdentitySetFileManager({
  checkId,
  clientId,
  targetDocumentSetId,
  currentDocumentCount,
  clientDocuments,
  mergeCandidates,
}: {
  checkId: string;
  clientId: string;
  targetDocumentSetId: string;
  currentDocumentCount: number;
  clientDocuments: SelectableGwgDocument[];
  mergeCandidates: IdentitySetFileCandidate[];
}) {
  const [mounted, setMounted] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [uploadedDocuments, setUploadedDocuments] = useState<SelectableGwgDocument[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<IdentitySetFileCandidate[]>([]);
  const [state, formAction, isPending] = useActionState<
    (ActionResult & { reviewReset?: boolean }) | null,
    FormData
  >(extendIdentityDocumentSetAction, null);
  const remaining = Math.max(0, 4 - currentDocumentCount);
  const documentSearch = useUnlinkedGwgDocumentSearch({
    checkId,
    clientId,
    initialDocuments: clientDocuments,
    query,
    enabled: pickerOpen,
  });

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!state?.ok) return;
    setSelectedCandidates([]);
    setPickerOpen(false);
  }, [state]);

  const allCandidates = useMemo(() => {
    const byKey = new Map<string, IdentitySetFileCandidate>();
    for (const candidate of mergeCandidates) {
      if (candidate.sourceDocumentSetId !== targetDocumentSetId) {
        byKey.set(candidate.key, candidate);
      }
    }
    for (const document of [...documentSearch.documents, ...uploadedDocuments]) {
      byKey.set(`document:${document.id}`, {
        key: `document:${document.id}`,
        sourceDocumentSetId: null,
        documents: [document],
      });
    }
    return [...byKey.values()];
  }, [documentSearch.documents, mergeCandidates, targetDocumentSetId, uploadedDocuments]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('de-DE');
    return allCandidates.filter(
      (candidate) =>
        !needle ||
        candidate.documents.some((document) =>
          document.title.toLocaleLowerCase('de-DE').includes(needle),
        ),
    );
  }, [allCandidates, query]);
  const selectedDocumentIds = selectedCandidates.flatMap((candidate) =>
    candidate.documents.map((document) => document.id),
  );

  function toggleCandidate(candidate: IdentitySetFileCandidate) {
    if (isPending) return;
    setSelectedCandidates((current) => {
      if (current.some((entry) => entry.key === candidate.key)) {
        return current.filter((entry) => entry.key !== candidate.key);
      }
      const currentCount = current.reduce((sum, entry) => sum + entry.documents.length, 0);
      return currentCount + candidate.documents.length <= remaining
        ? [...current, candidate]
        : current;
    });
  }

  const picker = pickerOpen ? (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={() => setPickerOpen(false)}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-4xl flex-col p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-default px-5 py-4">
          <div>
            <h2 className="font-semibold text-primary">Ausweisseiten aus der Akte ergänzen</h2>
            <p className="text-xs text-muted">
              Einzelne Dateien auswählen oder einen offenen Alt-Satz vollständig zusammenführen.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={() => setPickerOpen(false)}
            aria-label="Dateiauswahl schließen"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="border-b border-default p-4">
          <label className="sr-only" htmlFor={`identity-set-search-${targetDocumentSetId}`}>
            Dokumente durchsuchen
          </label>
          <input
            id={`identity-set-search-${targetDocumentSetId}`}
            type="search"
            className="input"
            placeholder="Titel in der gesamten Mandantenakte durchsuchen …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {candidates.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">
              {documentSearch.pending ? 'Durchsucht die gesamte Akte …' : 'Keine passende Datei.'}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {candidates.map((candidate) => {
                const selected = selectedCandidates.some((entry) => entry.key === candidate.key);
                const exceedsCapacity = candidate.documents.length > remaining;
                return (
                  <li
                    key={candidate.key}
                    className={`rounded-md border p-3 ${selected ? 'border-brand-500 bg-brand-50/40' : 'border-default'}`}
                  >
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {candidate.sourceDocumentSetId
                        ? `Offener Ausweissatz · ${candidate.documents.length} Dateien`
                        : 'Noch nicht zugeordnet'}
                    </p>
                    <div className="space-y-2">
                      {candidate.documents.map((document) => (
                        <div key={document.id} className="flex items-center justify-between gap-2">
                          <p className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                            {document.title}
                          </p>
                          <DocumentPreviewButton
                            documentId={document.id}
                            documentTitle={document.title}
                          />
                        </div>
                      ))}
                    </div>
                    {candidate.sourceDocumentSetId && (
                      <p className="mt-2 text-xs text-muted">
                        Alle Seiten dieses offenen Satzes werden gemeinsam übernommen.
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-secondary mt-3 w-full text-xs"
                      onClick={() => toggleCandidate(candidate)}
                      disabled={
                        isPending ||
                        (!selected &&
                          (exceedsCapacity ||
                            selectedDocumentIds.length + candidate.documents.length > remaining))
                      }
                    >
                      {selected ? 'Aus Auswahl entfernen' : 'Zum Ausweissatz hinzufügen'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 space-y-1 text-xs text-muted">
            {documentSearch.pending && (
              <p className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Gesamte Mandantenakte wird
                durchsucht …
              </p>
            )}
            {documentSearch.normalizedQuery.length < 2 && (
              <p>
                Gezeigt werden offene Alt-Sätze und die neuesten Belege. Ab zwei Zeichen wird die
                gesamte Akte durchsucht.
              </p>
            )}
            {documentSearch.limited && (
              <p>Mehr als 50 Treffer — bitte den Suchbegriff weiter eingrenzen.</p>
            )}
            {documentSearch.error && <p className="text-red-700">{documentSearch.error}</p>}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-default px-5 py-3">
          <p className="text-xs text-muted">
            {selectedDocumentIds.length} von {remaining} möglichen Dateien ausgewählt
          </p>
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={() => setPickerOpen(false)}
            disabled={selectedDocumentIds.length === 0}
          >
            Auswahl übernehmen
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (remaining === 0) {
    return (
      <p className="text-xs text-muted">
        Dieser Ausweissatz enthält bereits die maximal zulässigen vier Dateien.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-default bg-surface-raised p-3">
      <p className="text-sm font-medium text-primary">Vorder-/Rückseite ergänzen</p>
      <p className="mt-1 text-xs text-muted">
        Direkt hier eine vorhandene Datei bzw. einen offenen Alt-Satz auswählen oder eine weitere
        Seite hochladen. Danach wird der komplette Satz erneut bestätigt.
      </p>
      <form action={formAction} className="mt-3 space-y-3">
        <input type="hidden" name="checkId" value={checkId} />
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="targetDocumentSetId" value={targetDocumentSetId} />
        {selectedDocumentIds.map((documentId) => (
          <input key={documentId} type="hidden" name="documentIds" value={documentId} />
        ))}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setPickerOpen(true)}
            disabled={isPending}
          >
            <FileSearch className="h-3.5 w-3.5" /> Aus Akte auswählen
          </button>
          <DocumentUploadButton
            clientId={clientId}
            defaultClassification="GWG_EVIDENCE"
            requiredTier="GWG"
            buttonLabel="Weitere Ausweisseite hochladen"
            buttonClassName="btn-secondary text-xs"
            disabled={isPending || selectedDocumentIds.length >= remaining}
            onUploaded={(document) => {
              const uploaded = { ...document, createdAt: new Date().toISOString() };
              const key = `document:${uploaded.id}`;
              setUploadedDocuments((current) => [...current, uploaded]);
              setSelectedCandidates((current) =>
                current.some((candidate) => candidate.key === key)
                  ? current
                  : [...current, { key, sourceDocumentSetId: null, documents: [uploaded] }],
              );
            }}
          />
        </div>

        {selectedCandidates.length > 0 && (
          <ul className="space-y-1 text-xs text-primary">
            {selectedCandidates.map((candidate) => (
              <li key={candidate.key} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {candidate.sourceDocumentSetId
                    ? `Offener Satz (${candidate.documents.length} Dateien)`
                    : candidate.documents[0]!.title}
                </span>
                <button
                  type="button"
                  className="text-muted hover:text-primary"
                  onClick={() => toggleCandidate(candidate)}
                  aria-label="Aus Auswahl entfernen"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {state?.error && <div className="alert-error-sm">{state.error}</div>}
        {selectedDocumentIds.length > 0 && (
          <button type="submit" className="btn-primary text-xs" disabled={isPending}>
            {isPending ? 'Fügt hinzu …' : 'Auswahl zum Ausweissatz hinzufügen'}
          </button>
        )}
      </form>
      {mounted && picker ? createPortal(picker, document.body) : null}
    </div>
  );
}

function IdentityReviewCard({
  checkId,
  clientId,
  group,
  subjectOptions,
  clientDocuments,
  mergeCandidates,
  grandfathered,
  disabled,
  reviewMode,
}: {
  checkId: string;
  clientId: string;
  group: IdentityReviewGroup;
  subjectOptions: IdentitySubjectOption[];
  clientDocuments: SelectableGwgDocument[];
  mergeCandidates: IdentitySetFileCandidate[];
  grandfathered: boolean;
  disabled: boolean;
  reviewMode: boolean;
}) {
  const { markDraft } = useGwgEditState();
  const { invalidatedIdentitySets, acknowledgeIdentitySet } = useGwgIdentitySubjects();
  const first = group.documents[0]!;
  const [expanded, setExpanded] = useState(reviewMode);
  const [state, formAction, isPending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        revision?: string;
        saved?: IdentityReviewSavedState;
      })
    | null,
    FormData
  >(updateIdDocumentsAction, null);
  const serverState = useMemo<IdentityReviewLocalState>(
    () => ({
      revision: group.revision,
      fields: {
        type: first.type,
        number: first.number ?? '',
        issuedBy: first.issuedBy ?? '',
        issueDate: first.issueDate ?? '',
        expiryDate: first.expiryDate ?? '',
      },
      selectedSubjectKey: group.subjectKey ?? '',
      ownerName: first.ownerName,
      confirmedRevision: null,
    }),
    [
      first.expiryDate,
      first.issueDate,
      first.issuedBy,
      first.number,
      first.ownerName,
      first.type,
      group.revision,
      group.subjectKey,
    ],
  );
  const subjectKeys = useMemo(() => subjectOptions.map((option) => option.key), [subjectOptions]);
  const acknowledgeInvalidation = useCallback(
    (generation: number) => acknowledgeIdentitySet(group.documentSetId, generation),
    [acknowledgeIdentitySet, group.documentSetId],
  );
  const { localState, patchFields, selectSubject, markSubmitted } = useIdentityReviewState({
    initial: serverState,
    incoming: serverState,
    subjectKeys,
    actionState: state,
    onAcknowledgeInvalidation: acknowledgeInvalidation,
    onReviewReset: markDraft,
  });
  useEffect(() => {
    if (state?.ok) setExpanded(true);
  }, [state]);
  const attachedDocuments = group.documents.filter(
    (
      entry,
    ): entry is IdentityReviewDocument & {
      document: NonNullable<IdentityReviewDocument['document']>;
    } => entry.document !== null,
  );
  const invalidation = invalidatedIdentitySets[group.documentSetId];
  const invalidatedRevision = invalidation?.revision;
  const invalidated = invalidatedRevision !== undefined;
  const { fields, selectedSubjectKey, revision: currentRevision } = localState;
  const currentSubject = subjectOptions.find((option) => option.key === selectedSubjectKey);
  const duplicateRoleNames = new Set(
    subjectOptions
      .filter((option, index, all) => {
        const normalizedName = option.name.normalize('NFKC').trim().toLocaleLowerCase('de-DE');
        return all.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index &&
            candidate.kind !== option.kind &&
            candidate.name.normalize('NFKC').trim().toLocaleLowerCase('de-DE') === normalizedName,
        );
      })
      .map((option) => option.name.normalize('NFKC').trim().toLocaleLowerCase('de-DE')),
  );
  const displayedType = fields.type;
  const displayedOwnerName = invalidated ? (currentSubject?.name ?? '') : localState.ownerName;
  const displayedNumber = fields.number;
  const displayedExpiryDate = fields.expiryDate;
  const expired = Boolean(
    displayedExpiryDate && displayedExpiryDate < new Date().toISOString().slice(0, 10),
  );
  const persistedConfirmation =
    !expired &&
    group.subjectKey !== null &&
    attachedDocuments.length === group.documents.length &&
    group.documents.every(
      (entry) =>
        entry.verifiedAt !== null &&
        entry.identityAssignmentConfirmedAt !== null &&
        entry.identityAssignmentConfirmedBy !== null &&
        Boolean(entry.number?.trim()) &&
        Boolean(entry.issuedBy?.trim()) &&
        entry.issueDate !== null &&
        entry.expiryDate !== null &&
        entry.type === first.type &&
        entry.number === first.number &&
        entry.issuedBy === first.issuedBy &&
        entry.issueDate === first.issueDate &&
        entry.expiryDate === first.expiryDate,
    );
  const confirmed =
    grandfathered ||
    (!invalidated &&
      (localState.confirmedRevision === localState.revision || persistedConfirmation));

  return (
    <details
      className="group rounded-md border border-default bg-surface"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <FileCheck className={confirmed ? 'h-5 w-5 text-green-600' : 'h-5 w-5 text-amber-600'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-primary">{typeLabels[displayedType]}</span>
            <span className={confirmed ? 'badge-green' : 'badge-yellow'}>
              {grandfathered
                ? 'Bestandsnachweis'
                : confirmed
                  ? 'Angaben bestätigt'
                  : expired
                    ? 'Ausweis abgelaufen'
                    : 'Prüfung offen'}
            </span>
          </div>
          <p className="truncate text-xs text-muted">
            {displayedOwnerName || 'Person noch nicht zugeordnet'}
            {displayedNumber ? ` · Nr. ${displayedNumber}` : ''} · {attachedDocuments.length}{' '}
            {attachedDocuments.length === 1 ? 'Datei' : 'Dateien'}
          </p>
        </div>
        <span className="text-xs text-brand-700">{expanded ? 'Zuklappen' : 'Ausweis prüfen'}</span>
        <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" />
      </summary>

      <div className="space-y-5 border-t border-default p-4">
        {grandfathered && (
          <div className="alert-info-sm">
            Dieser verifizierte Bestandsnachweis stammt aus der Zeit vor der technischen
            1:1-Personenzuordnung. Er bleibt für die abgeschlossene Altprüfung gültig; bei der
            nächsten Prüfung wird die konkrete Person verbindlich neu zugeordnet.
          </div>
        )}
        {invalidated && (
          <div className="alert-info-sm">
            Die zugeordnete Person wurde geändert. Die Ausweisdaten bleiben sichtbar, müssen aber
            mit der aktuellen Person erneut bestätigt werden.
          </div>
        )}
        {attachedDocuments.length < group.documents.length && (
          <div className="alert-error-sm">
            Mindestens eine Datei dieses Ausweissatzes ist nicht mehr verfügbar. Bitte einen neuen
            vollständigen Ausweissatz zuordnen.
          </div>
        )}
        {attachedDocuments.length > 0 ? (
          <div className={`grid gap-4 ${attachedDocuments.length > 1 ? 'xl:grid-cols-2' : ''}`}>
            {attachedDocuments.map((entry) => (
              <InlineEvidence
                key={entry.document.id}
                document={entry.document}
                label={
                  entry.notes?.startsWith('Vorderseite')
                    ? 'Vorderseite'
                    : entry.notes?.startsWith('Rückseite')
                      ? 'Rückseite'
                      : null
                }
                active={expanded}
              />
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted">Keine Vorschau verfügbar.</div>
        )}

        {!disabled && (
          <IdentitySetFileManager
            checkId={checkId}
            clientId={clientId}
            targetDocumentSetId={group.documentSetId}
            currentDocumentCount={group.documents.length}
            clientDocuments={clientDocuments}
            mergeCandidates={mergeCandidates}
          />
        )}

        <form
          action={formAction}
          className="space-y-4"
          onSubmit={() => {
            markSubmitted(
              invalidatedRevision ?? localState.revision,
              invalidation?.generation ?? null,
            );
          }}
        >
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="documentSetId" value={group.documentSetId} />
          <input
            type="hidden"
            name="expectedRevision"
            value={invalidatedRevision ?? currentRevision}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`identity-type-${group.key}`}>
                Ausweistyp
              </label>
              <select
                id={`identity-type-${group.key}`}
                name="type"
                className="input"
                value={fields.type}
                onChange={(event) =>
                  patchFields({
                    type: event.target.value as 'PERSONALAUSWEIS' | 'REISEPASS',
                  })
                }
                disabled={disabled || isPending}
              >
                <option value="PERSONALAUSWEIS">Personalausweis</option>
                <option value="REISEPASS">Reisepass</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`identity-subject-${group.key}`}>
                Identifizierte Person
              </label>
              <select
                id={`identity-subject-${group.key}`}
                name="subjectKey"
                className="input"
                value={selectedSubjectKey}
                onChange={(event) => selectSubject(event.target.value)}
                required
                disabled={disabled || isPending}
              >
                <option value="" disabled>
                  — erfasste Person auswählen —
                </option>
                {subjectOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name} — {identitySubjectRoleLabel(option)}
                  </option>
                ))}
              </select>
              {!selectedSubjectKey && (
                <p className="mt-1 text-xs text-amber-700">
                  Der bisherige Anzeigewert „{first.ownerName}“ besitzt noch keine bestätigte
                  1:1-Zuordnung. Bitte die konkrete Person auswählen.
                </p>
              )}
              {duplicateRoleNames.size > 0 && (
                <p className="mt-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                  Gleichnamige Einträge in verschiedenen Rollen sind nicht automatisch zwei
                  Personen. Wählen Sie bewusst die Rollen-Zuordnung: Für den Vertretungsnachweis
                  muss der Eintrag „vertretungsberechtigt“ gewählt werden; Geburtsdatum und
                  Eintragsnummer unterscheiden echte Namensdopplungen.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor={`identity-number-${group.key}`}>
                Ausweisnummer
              </label>
              <input
                id={`identity-number-${group.key}`}
                name="number"
                className="input"
                value={fields.number}
                onChange={(event) => patchFields({ number: event.target.value })}
                required
                maxLength={100}
                disabled={disabled || isPending}
              />
            </div>
            <div>
              <label className="label" htmlFor={`identity-issue-date-${group.key}`}>
                Ausgestellt am
              </label>
              <input
                id={`identity-issue-date-${group.key}`}
                name="issueDate"
                type="date"
                className="input"
                value={fields.issueDate}
                onChange={(event) => patchFields({ issueDate: event.target.value })}
                required
                disabled={disabled || isPending}
              />
            </div>
            <div>
              <label className="label" htmlFor={`identity-expiry-date-${group.key}`}>
                Gültig bis
              </label>
              <input
                id={`identity-expiry-date-${group.key}`}
                name="expiryDate"
                type="date"
                className="input"
                value={fields.expiryDate}
                onChange={(event) => patchFields({ expiryDate: event.target.value })}
                required
                disabled={disabled || isPending}
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor={`identity-issued-by-${group.key}`}>
              Ausstellende Behörde
            </label>
            <input
              id={`identity-issued-by-${group.key}`}
              name="issuedBy"
              className="input"
              value={fields.issuedBy}
              onChange={(event) => patchFields({ issuedBy: event.target.value })}
              required
              maxLength={200}
              disabled={disabled || isPending}
            />
          </div>

          {state?.error && <div className="alert-error-sm">{state.error}</div>}
          {state?.ok && !invalidated && (
            <div className="alert-success-sm">Ausweisangaben wurden bestätigt.</div>
          )}
          {!disabled && (
            <button
              type="submit"
              className="btn-primary text-sm"
              disabled={
                isPending ||
                attachedDocuments.length !== group.documents.length ||
                subjectOptions.length === 0
              }
            >
              {isPending
                ? 'Speichert…'
                : confirmed
                  ? 'Änderungen speichern und bestätigen'
                  : 'Angaben übernehmen und bestätigen'}
            </button>
          )}
        </form>
      </div>
    </details>
  );
}

export function IdentityDocumentReview({
  checkId,
  clientId,
  groups,
  subjectOptions,
  clientDocuments,
  grandfathered,
  disabled,
  reviewMode = false,
}: {
  checkId: string;
  clientId: string;
  groups: IdentityReviewGroup[];
  subjectOptions: IdentitySubjectOption[];
  clientDocuments: SelectableGwgDocument[];
  grandfathered: boolean;
  disabled: boolean;
  reviewMode?: boolean;
}) {
  const { subjectOptions: allSubjectOptions } = useGwgIdentitySubjects(subjectOptions);
  const availableSubjectOptions = useMemo(
    () => selectableIdentitySubjectOptions(allSubjectOptions),
    [allSubjectOptions],
  );
  if (groups.length === 0) {
    return <p className="mb-4 text-xs text-disabled">Noch kein Ausweis zugeordnet.</p>;
  }
  const mergeCandidates: IdentitySetFileCandidate[] = groups
    .filter(
      (group) =>
        group.documents.length > 0 &&
        group.documents.every(
          (document) =>
            document.document !== null &&
            document.verifiedAt === null &&
            document.identityAssignmentConfirmedAt === null &&
            document.identityAssignmentConfirmedBy === null,
        ),
    )
    .map((group) => ({
      key: `set:${group.documentSetId}`,
      sourceDocumentSetId: group.documentSetId,
      documents: group.documents.map((document) => document.document!),
    }));

  return (
    <div className="mb-4 space-y-3">
      {groups.map((group) => (
        <IdentityReviewCard
          // Keep the card mounted across RSC revalidation. Verification
          // timestamps and subject assignment change after every save; using
          // them as part of the key discarded the local successor revision
          // before a second save could use it.
          key={group.documentSetId}
          checkId={checkId}
          clientId={clientId}
          group={group}
          subjectOptions={availableSubjectOptions}
          clientDocuments={clientDocuments}
          mergeCandidates={mergeCandidates}
          grandfathered={grandfathered}
          disabled={disabled}
          reviewMode={reviewMode}
        />
      ))}
    </div>
  );
}
