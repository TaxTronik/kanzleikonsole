'use client';

import { useEffect, useRef, useState, useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileDown, Loader2, Sparkles } from 'lucide-react';
import { analyzeAction, importDocTextAction, importClientDocAction } from './actions';
import { DisclaimerBanner } from './disclaimer-banner';
import { SubsumtionDocument, type SubsumtionDocumentHandle } from './subsumtion-document';
import type { SubsumtionWorkspaceProps } from './workspace-types';

export function SubsumtionCompose({
  clientId,
  clientDocuments,
  engineConfigured,
}: SubsumtionWorkspaceProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [docId, setDocId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<SubsumtionDocumentHandle>(null);
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), 4500);
    return () => clearTimeout(timer);
  }, [info]);
  function appendToEditor(imported: string) {
    editorRef.current?.appendText(imported);
  }
  // --- Compose-Aktionen ---
  function analyze() {
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await analyzeAction({
        clientId,
        text,
        title: title.trim() || undefined,
        doc: editorRef.current?.getDoc() ?? undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/staff/clients/${clientId}/subsumtion/${r.analysisId}`);
    });
  }
  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setInfo(null);
    start(async () => {
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('file', file);
      const r = await importDocTextAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      appendToEditor(r.text);
      // Titel-Vorschlag nur übernehmen, wenn noch keiner gesetzt ist.
      setTitle((current) => (current.trim() ? current : (r.suggestedTitle ?? current)));
      setInfo('Text aus Dokument übernommen.');
    });
  }
  function importExisting() {
    if (!docId) return;
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await importClientDocAction({ clientId, documentId: docId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      appendToEditor(r.text);
      setTitle((current) => (current.trim() ? current : (r.suggestedTitle ?? current)));
      setInfo('Text aus Mandanten-Dokument übernommen.');
    });
  }

  return (
    <div className="space-y-3">
      <DisclaimerBanner />
      {!engineConfigured && (
        <div className="alert-error-sm">
          Die Risk-Engine ist nicht konfiguriert — Analyse derzeit nicht möglich. Sachverhalt kann
          erfasst, aber noch nicht analysiert werden.
        </div>
      )}
      {error && <div className="alert-error-sm">{error}</div>}
      {info && <div className="text-sm text-emerald-700 dark:text-emerald-300">{info}</div>}
      <section className="card overflow-hidden">
        <div className="border-b border-default p-6">
          <label className="label" htmlFor="subsumtion-title">
            Bezeichnung
          </label>
          <input
            id="subsumtion-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional, z. B. „Umstrukturierung M-Gruppe“"
            className="input text-lg font-semibold"
          />
          <p className="mt-3 text-xs text-muted">
            Sachverhalt direkt formatiert erfassen oder aus einem Dokument importieren. Bei
            fragmentierten Importen hilft „Absätze zusammenführen“. Für die Analyse zählt der reine
            Text.
          </p>
        </div>

        <SubsumtionDocument
          ref={editorRef}
          analyzed={false}
          canEdit
          initialDoc={null}
          initialText=""
          onTextChange={setText}
        />

        {clientDocuments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-default bg-surface-raised px-6 py-4">
            <select
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
              className="input min-w-0 flex-1 sm:max-w-xl"
            >
              <option value="">Aus Mandanten-Dokument wählen …</option>
              {clientDocuments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.typeName ? ` (${d.typeName})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={importExisting}
              disabled={pending || !docId}
              className="btn-secondary text-sm"
            >
              <FileDown className="h-4 w-4" /> Übernehmen
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-default bg-surface px-6 py-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="btn-secondary text-sm"
          >
            <Upload className="h-4 w-4" />
            Aus Dokument importieren
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={onFile}
            className="hidden"
          />
          <span className="text-xs text-muted sm:ml-auto">{text.length} Zeichen</span>
          <button
            type="button"
            onClick={analyze}
            disabled={pending || !engineConfigured || !text.trim()}
            className="btn-primary text-sm"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Analysieren
          </button>
        </div>
      </section>
    </div>
  );
}
