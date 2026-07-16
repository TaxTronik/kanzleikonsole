'use client';

import { useState, useTransition, useEffect, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Upload, X } from 'lucide-react';
import { useDocumentCommit } from '@/components/use-document-commit';

interface Props {
  clientId?: string;
  folderId?: string;
  /** Optionaler Sachverhalts-Bezug — der Upload setzt analysis_id (Aktenregal-Tab). */
  analysisId?: string;
  defaultClassification?: string;
  buttonLabel?: string;
  buttonClassName?: string;
  disabled?: boolean;
  /** Begrenzt den Uploaddialog auf Typen derselben Schutzstufe. */
  requiredTier?: DocType['tier'];
  /** Kombinierte Fachdialoge können das neue Dokument sofort weiterverarbeiten. */
  onUploaded?: (document: { id: string; title: string }) => void | Promise<void>;
}

interface DocType {
  id: string;
  name: string;
  tier: 'NONE' | 'GWG' | 'GOBD';
  retentionYears: number | null;
  builtin: boolean;
  classificationKey: string | null;
}
const tierHint = (type: DocType): string =>
  type.tier === 'NONE'
    ? ''
    : type.tier === 'GOBD'
      ? `GoBD · ${type.retentionYears ?? '?'} Jahre COMPLIANCE-Lock`
      : 'GwG · GOVERNANCE-Schutz; Löschfrist wird fachlich geprüft';

export function DocumentUploadButton({
  clientId,
  folderId,
  analysisId,
  defaultClassification = 'GENERAL',
  buttonLabel = 'Hochladen',
  buttonClassName = 'btn-primary text-xs py-1.5',
  disabled = false,
  requiredTier,
  onUploaded,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // SSR-Guard: createPortal nutzt document, das im Server-Render nicht
  // existiert. Erst nach Mount portalen — sonst Hydration-Mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [types, setTypes] = useState<DocType[]>([]);
  const [typeId, setTypeId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<'idle' | 'presign' | 'upload' | 'commit'>('idle');
  const [isPending, startTransition] = useTransition();
  const commitDocument = useDocumentCommit();

  // Typen erst beim Öffnen laden (Kern + eigene, nur aktive).
  useEffect(() => {
    if (!open || types.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/staff/document-types');
        if (!res.ok) return;
        const data = (await res.json()) as { types: DocType[] };
        if (cancelled) return;
        setTypes(
          requiredTier ? data.types.filter((type) => type.tier === requiredTier) : data.types,
        );
      } catch {
        /* ignore — Upload-Button bleibt nutzbar, Fehler beim Submit */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, requiredTier, types.length]);

  // Vorauswahl setzen, sobald Typen da sind und nichts gewählt ist
  // (greift auch beim Wieder-Öffnen nach reset()).
  useEffect(() => {
    if (!open || typeId || types.length === 0) return;
    const preset =
      types.find((t) => t.classificationKey === defaultClassification) ??
      types.find((t) => t.classificationKey === 'GENERAL') ??
      types[0];
    if (preset) setTypeId(preset.id);
  }, [open, typeId, types, defaultClassification]);

  function reset() {
    setFile(null);
    setTitle('');
    setTypeId('');
    setError(null);
    setProgress('idle');
  }

  function close() {
    if (isPending || progress !== 'idle') return;
    reset();
    setOpen(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Das Portal kann logisch unter einem anderen Fachformular liegen. Der
    // Upload-Submit darf deshalb nicht bis zu diesem Elternformular bubbelen.
    event.stopPropagation();
    setError(null);
    if (!file) {
      setError('Bitte eine Datei auswählen.');
      return;
    }
    if (!typeId) {
      setError('Bitte einen Datei-Typ wählen.');
      return;
    }

    startTransition(async () => {
      try {
        // Ein einziger POST: Datei + Felder als multipart. Die App
        // streamt intern zu SeaweedFS (kein presigned-direct mehr).
        setProgress('upload');
        const fd = new FormData();
        fd.set('file', file);
        fd.set('documentTypeId', typeId);
        fd.set('title', title || file.name);
        fd.set('mimeType', file.type || 'application/octet-stream');
        if (clientId) fd.set('clientId', clientId);
        if (folderId) fd.set('folderId', folderId);
        if (analysisId) fd.set('analysisId', analysisId);

        setProgress('commit');
        const response = await commitDocument(fd);
        const uploadedDocument = { id: response.documentId, title: title || file.name };

        // Fachdialoge erhalten die ID direkt und können die Zuordnung im
        // selben Nutzerfluss abschließen. Alle bisherigen Aufrufer behalten
        // das Refresh-Verhalten unverändert.
        if (onUploaded) await onUploaded(uploadedDocument);
        reset();
        setOpen(false);
        if (!onUploaded) router.refresh();
      } catch (err) {
        setError((err as Error).message);
        setProgress('idle');
      }
    });
  }

  // Modal in Portal an `document.body` rendern — Modern-Mode setzt
  // `transform: translateY(-2px)` auf `.card:hover`, was einen
  // Containing-Block für `position: fixed`-Kinder erzeugt. Inline gerendert
  // hängt das Modal sonst an der nächsten transformierten Karte (springt
  // beim Card-Hover sichtbar). Portal entkoppelt es vom Parent-DOM.
  const modal = open ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={close} className="modal-close" aria-label="Schließen">
          <X className="h-5 w-5" />
        </button>

        <h2 className="text-lg font-semibold text-primary mb-4">Dokument hochladen</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="upload-file">
              Datei
            </label>
            <input
              id="upload-file"
              type="file"
              className="input"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
              }}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="upload-title">
              Titel
            </label>
            <input
              id="upload-title"
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={file?.name ?? 'Optionaler Titel'}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="upload-type">
              Datei-Typ
            </label>
            <select
              id="upload-type"
              className="input"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
            >
              {types.length === 0 && <option value="">Lädt…</option>}
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.tier !== 'NONE'
                    ? ` — ${t.tier === 'GOBD' ? 'GoBD' : 'GwG'} ${t.retentionYears ?? '?'} J.`
                    : ''}
                </option>
              ))}
            </select>
            {requiredTier && types.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Für die benötigte Schutzstufe ist kein aktiver Datei-Typ eingerichtet.
              </p>
            )}
            {(() => {
              const sel = types.find((t) => t.id === typeId);
              return sel && sel.tier !== 'NONE' ? (
                <p className="mt-1 text-xs text-amber-700">{tierHint(sel)}</p>
              ) : null;
            })()}
          </div>

          {error && <div className="alert-error-sm">{error}</div>}

          {progress !== 'idle' && (
            <div className="alert-info-sm">
              {progress === 'presign' && 'Hochladevorbereitung…'}
              {progress === 'upload' && 'Datei wird hochgeladen…'}
              {progress === 'commit' && 'Virus-Scan & Verarbeitung…'}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="btn-secondary flex-1"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={isPending || !file || !typeId}
              className="btn-primary flex-1"
            >
              {isPending ? 'Lädt…' : 'Hochladen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Upload className="h-3.5 w-3.5" />
        {buttonLabel}
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
