'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { FileSearch, Loader2, X } from 'lucide-react';
import { addIdDocumentAction } from './id-document-actions';
import { type ActionResult } from './actions';
import { DocumentPreviewButton } from '@/components/document-preview';
import { DocumentUploadButton } from '@/components/document-upload-button';
import {
  identitySubjectRoleLabel,
  selectableIdentitySubjectOptions,
  type IdentitySubjectOption,
} from '@/server/gwg/identity-subject';
import {
  useUnlinkedGwgDocumentSearch,
  type SelectableGwgDocument,
} from './use-gwg-document-search';
import { useGwgIdentitySubjects } from './identity-subjects-context';

const identityTypes = [
  { value: 'PERSONALAUSWEIS', label: 'Personalausweis' },
  { value: 'REISEPASS', label: 'Reisepass' },
] as const;

const entityTypes = [
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Rechtsträgernachweis' },
] as const;

const EMPTY_SUBJECT_OPTIONS: IdentitySubjectOption[] = [];

interface Props {
  checkId: string;
  clientId: string;
  clientDocuments: SelectableGwgDocument[];
  variant: 'identity' | 'entity';
  subjectOptions?: IdentitySubjectOption[];
}

export function AddIdDocumentForm({
  checkId,
  clientId,
  clientDocuments,
  variant,
  subjectOptions = EMPTY_SUBJECT_OPTIONS,
}: Props) {
  const { subjectOptions: allSubjects } = useGwgIdentitySubjects(subjectOptions);
  const availableSubjects = useMemo(
    () => selectableIdentitySubjectOptions(allSubjects),
    [allSubjects],
  );
  const formRef = useRef<HTMLFormElement>(null);
  const primaryDocumentIdRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const types = variant === 'identity' ? identityTypes : entityTypes;
  const [type, setType] = useState<string>(types[0].value);
  const [selectedDocuments, setSelectedDocuments] = useState<SelectableGwgDocument[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedSubjectKey, setSelectedSubjectKey] = useState(
    availableSubjects.length === 1 ? availableSubjects[0]!.key : '',
  );
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addIdDocumentAction,
    null,
  );

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setSelectedSubjectKey((current) =>
      availableSubjects.some((option) => option.key === current)
        ? current
        : availableSubjects.length === 1
          ? availableSubjects[0]!.key
          : '',
    );
  }, [availableSubjects]);
  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    setType(types[0].value);
    setSelectedDocuments([]);
    // Refresh außerhalb der Form-Transition (Action revalidiert die aktuelle
    // Route nicht mehr — sonst hing die Transition bis zum nächsten Klick).
    router.refresh();
  }, [router, state, types]);
  useEffect(() => {
    if (!isPending) submittingRef.current = false;
  }, [isPending]);

  const documentSearch = useUnlinkedGwgDocumentSearch({
    checkId,
    clientId,
    initialDocuments: clientDocuments,
    query,
    enabled: pickerOpen,
  });

  function selectDocument(document: SelectableGwgDocument) {
    if (isPending || submittingRef.current) return;
    if (variant === 'identity') {
      setSelectedDocuments((current) =>
        current.some((entry) => entry.id === document.id) || current.length >= 4
          ? current
          : [...current, document],
      );
      return;
    }
    setSelectedDocuments([document]);
    if (primaryDocumentIdRef.current) primaryDocumentIdRef.current.value = document.id;
    setPickerOpen(false);
    // Ist das Formular bereits vollständig, schliesst die Auswahl bzw. der
    // Upload die Zuordnung direkt ab. Bei fehlenden Pflichtfeldern fokussiert
    // die native Formularvalidierung das konkrete Feld; kein zweiter
    // Zuordnungsdialog ist nötig.
    queueMicrotask(() => {
      const form = formRef.current;
      if (!form || submittingRef.current || !form.checkValidity()) {
        form?.reportValidity();
        return;
      }
      submittingRef.current = true;
      form.requestSubmit();
    });
  }

  function toggleIdentityDocument(document: SelectableGwgDocument) {
    if (isPending || submittingRef.current) return;
    setSelectedDocuments((current) =>
      current.some((entry) => entry.id === document.id)
        ? current.filter((entry) => entry.id !== document.id)
        : current.length >= 4
          ? current
          : [...current, document],
    );
  }

  const picker = pickerOpen ? (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={() => setPickerOpen(false)}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-3xl flex-col p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-default px-5 py-4">
          <div>
            <h2 className="font-semibold text-primary">Dokument aus der Mandantenakte</h2>
            <p className="text-xs text-muted">Nur verfügbare GwG-Nachweise werden angezeigt.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={() => setPickerOpen(false)}
            aria-label="Dokumentauswahl schließen"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="border-b border-default p-4">
          <label className="sr-only" htmlFor={`${variant}-document-search`}>
            Dokumente durchsuchen
          </label>
          <input
            id={`${variant}-document-search`}
            className="input"
            type="search"
            placeholder="Titel durchsuchen …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {documentSearch.documents.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">
              {documentSearch.pending
                ? 'Durchsucht die gesamte Akte …'
                : 'Kein passender GwG-Nachweis.'}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {documentSearch.documents.map((document) => {
                const selected = selectedDocuments.some((entry) => entry.id === document.id);
                return (
                  <li
                    key={document.id}
                    className={`rounded-md border p-3 ${selected ? 'border-brand-500 bg-brand-50/40' : 'border-default'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-primary">
                          {document.title}
                        </p>
                        <p className="text-xs text-muted">
                          {new Intl.DateTimeFormat('de-DE').format(new Date(document.createdAt))}
                        </p>
                      </div>
                      <DocumentPreviewButton
                        documentId={document.id}
                        documentTitle={document.title}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-secondary mt-3 w-full text-xs"
                      onClick={() =>
                        variant === 'identity'
                          ? toggleIdentityDocument(document)
                          : selectDocument(document)
                      }
                      disabled={
                        isPending ||
                        (variant === 'identity' && !selected && selectedDocuments.length >= 4)
                      }
                    >
                      {variant === 'identity'
                        ? selected
                          ? 'Aus Satz entfernen'
                          : 'Zum Ausweissatz hinzufügen'
                        : 'Dieses Dokument verwenden'}
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
                Gezeigt werden die neuesten Belege. Ab zwei Zeichen durchsucht die Suche die gesamte
                Akte.
              </p>
            )}
            {documentSearch.limited && (
              <p>Mehr als 50 Treffer — bitte den Suchbegriff weiter eingrenzen.</p>
            )}
            {documentSearch.error && <p className="text-red-700">{documentSearch.error}</p>}
          </div>
        </div>
        {variant === 'identity' && (
          <div className="flex items-center justify-between gap-3 border-t border-default px-5 py-3">
            <p className="text-xs text-muted">
              {selectedDocuments.length} von maximal 4 Dateien ausgewählt
            </p>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => setPickerOpen(false)}
              disabled={selectedDocuments.length === 0}
            >
              Auswahl übernehmen
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <form
        ref={formRef}
        action={formAction}
        className="space-y-4 rounded-md border border-dashed border-strong p-4"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">
            {variant === 'identity' ? 'Ausweis prüfen und zuordnen' : 'Nachweis hinzufügen'}
          </p>
          <p className="mt-1 text-xs text-muted">
            {variant === 'identity'
              ? 'Vorder- und Rückseite gemeinsam aus der Akte auswählen oder nacheinander hochladen und anschließend als einen Ausweissatz speichern.'
              : 'Vorhandenes Dokument auswählen oder direkt hochladen — die GwG-Zuordnung wird dabei sofort mitgespeichert.'}
          </p>
        </div>
        <input type="hidden" name="checkId" value={checkId} />
        <input type="hidden" name="clientId" value={clientId} />
        <input
          ref={primaryDocumentIdRef}
          type="hidden"
          name="documentIds"
          value={selectedDocuments[0]?.id ?? ''}
        />
        {selectedDocuments.slice(1).map((document) => (
          <input key={document.id} type="hidden" name="documentIds" value={document.id} />
        ))}

        <div className={variant === 'identity' ? 'grid gap-3 sm:grid-cols-2' : ''}>
          <div>
            <label className="label" htmlFor={`${variant}-document-type`}>
              Nachweistyp
            </label>
            <select
              id={`${variant}-document-type`}
              name="type"
              className="input"
              required
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              {types.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          {variant === 'identity' && (
            <div>
              <label className="label" htmlFor="id-subjectKey">
                Identifizierte Person
              </label>
              <select
                id="id-subjectKey"
                name="subjectKey"
                className="input"
                required
                value={selectedSubjectKey}
                onChange={(event) => setSelectedSubjectKey(event.target.value)}
              >
                <option value="" disabled>
                  — erfasste Person auswählen —
                </option>
                {availableSubjects.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name} — {identitySubjectRoleLabel(option)}
                  </option>
                ))}
              </select>
              {availableSubjects.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  Erfassen Sie zuerst den Mandanten bzw. eine vertretungs- oder wirtschaftlich
                  berechtigte Person.
                </p>
              )}
            </div>
          )}
        </div>

        {variant === 'identity' && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="id-number">
                  Ausweisnummer
                </label>
                <input id="id-number" name="number" className="input" maxLength={100} />
              </div>
              <div>
                <label className="label" htmlFor="id-issueDate">
                  Ausgestellt am
                </label>
                <input id="id-issueDate" name="issueDate" type="date" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="id-expiryDate">
                  Gültig bis
                </label>
                <input id="id-expiryDate" name="expiryDate" type="date" className="input" />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="id-issuedBy">
                Ausstellende Behörde
              </label>
              <input id="id-issuedBy" name="issuedBy" className="input" maxLength={200} />
            </div>
            <p className="text-xs text-muted">
              Nummer, Ausstellungsdatum, Behörde und Gültigkeit können Sie nach dem Zuordnen direkt
              unter der aufgeklappten Ausweiskopie vervollständigen oder korrigieren.
            </p>
          </>
        )}

        <div className="rounded-md border border-default bg-surface-raised p-3">
          {selectedDocuments.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                {variant === 'identity' ? 'Dateien im Ausweissatz' : 'Ausgewählter Nachweis'}
              </p>
              {selectedDocuments.map((document) => (
                <div
                  key={document.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-default bg-surface p-2"
                >
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                    {document.title}
                  </p>
                  <DocumentPreviewButton documentId={document.id} documentTitle={document.title} />
                  <button
                    type="button"
                    className="btn-secondary px-2 text-xs"
                    aria-label={`${document.title} aus Auswahl entfernen`}
                    onClick={() =>
                      setSelectedDocuments((current) =>
                        current.filter((entry) => entry.id !== document.id),
                      )
                    }
                    disabled={isPending}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Noch kein Dokument ausgewählt.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setPickerOpen(true)}
              disabled={isPending}
            >
              <FileSearch className="h-3.5 w-3.5" />
              Aus Akte auswählen
            </button>
            <DocumentUploadButton
              clientId={clientId}
              defaultClassification="GWG_EVIDENCE"
              requiredTier="GWG"
              buttonLabel={
                variant === 'identity'
                  ? selectedDocuments.length > 0
                    ? 'Weitere Seite hochladen'
                    : 'Neue Ausweisseite hochladen'
                  : 'Neu hochladen und zuordnen'
              }
              buttonClassName="btn-secondary text-xs"
              disabled={
                isPending ||
                (variant === 'identity' && (!selectedSubjectKey || selectedDocuments.length >= 4))
              }
              onUploaded={(document) =>
                selectDocument({ ...document, createdAt: new Date().toISOString() })
              }
            />
          </div>
          {variant === 'identity' && !selectedSubjectKey && (
            <p className="mt-2 text-xs text-amber-700">
              Bitte zuerst die identifizierte Person wählen; danach können Vorder- und Rückseite
              hochgeladen und gemeinsam eindeutig zugeordnet werden.
            </p>
          )}
        </div>

        {state?.error && <div className="alert-error-sm">{state.error}</div>}
        {state?.ok && (
          <div className="alert-success-sm">
            {variant === 'identity'
              ? 'Ausweissatz wurde eindeutig zugeordnet.'
              : 'Nachweis wurde direkt zugeordnet.'}
          </div>
        )}

        <button
          type="submit"
          className="btn-primary text-sm"
          disabled={
            isPending ||
            selectedDocuments.length === 0 ||
            (variant === 'identity' && !availableSubjects.length)
          }
        >
          {isPending
            ? 'Speichert…'
            : variant === 'identity'
              ? 'Ausweissatz speichern'
              : 'Auswahl speichern'}
        </button>
      </form>
      {mounted && picker ? createPortal(picker, document.body) : null}
    </>
  );
}
