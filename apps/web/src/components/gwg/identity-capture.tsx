'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  compareWithMrz,
  IDENTITY_FIELD_LABELS,
  type IdentityField,
  type IdentityOcrResult,
  type IdentitySuggestions,
  type IdentityWarning,
} from '@/lib/gwg/identity-ocr';
import { IDENTITY_UI_TEXT, warningText, type IdentityAudience } from '@/lib/gwg/identity-hints';
import {
  fullIdentityViewport,
  type IdentitySourceView,
  type IdentityViewport,
} from '@/lib/gwg/identity-viewport';
import {
  cropIdentityImage,
  loadIdentityImage,
  recognizeIdentityImage,
  type IdentityImage,
} from '@/lib/gwg/identity-image';

const DATE_FIELDS: ReadonlySet<IdentityField> = new Set([
  'birthDate',
  'idIssueDate',
  'idExpiryDate',
]);

/** Mandanten sehen Daten wie auf dem Ausweis (TT.MM.JJJJ); übernommen wird ISO. */
function displayValue(field: IdentityField, value: string, audience: IdentityAudience): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return audience === 'client' && DATE_FIELDS.has(field) && iso
    ? `${iso[3]}.${iso[2]}.${iso[1]}`
    : value;
}

export interface IdentityCaptureSource {
  id: string;
  label: string;
  load(): Promise<{ blob: Blob; versionId: string }>;
}

/** Shared by staff and the public invitation. No verification action is available here. */
export function IdentityCapture({
  sources,
  current,
  onApply,
  onViewChange,
  initialViews = [],
  audience = 'staff',
}: {
  sources: IdentityCaptureSource[];
  current: IdentitySuggestions;
  onApply: (fields: IdentitySuggestions) => void;
  onViewChange: (view: IdentitySourceView) => void;
  initialViews?: IdentitySourceView[];
  /** Mandanten im öffentlichen Onboarding erhalten verständliche Texte. */
  audience?: IdentityAudience;
}) {
  const text = IDENTITY_UI_TEXT[audience];
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<IdentityImage | null>(null);
  const [view, setView] = useState<IdentityViewport | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState('');
  const [croppedPreview, setCroppedPreview] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<IdentityOcrResult | null>(null);
  const [selected, setSelected] = useState<IdentityField[]>([]);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const sourceRef = useRef<IdentityImage | null>(null);
  // Abgleich der Ausweisseiten: Vorschläge der Sichtseite und die
  // prüfziffergesicherte MRZ der Rückseite aus früheren Erkennungen.
  const lastFields = useRef<IdentitySuggestions>({});
  const lastMrz = useRef<IdentityOcrResult['mrz']>(undefined);
  useEffect(
    () => () => {
      request.current++;
      controller.current?.abort();
      sourceRef.current?.dispose();
    },
    [],
  );

  function cancel() {
    request.current++;
    controller.current?.abort();
    if (!controller.current) {
      sourceRef.current?.dispose();
      sourceRef.current = null;
      setSource(null);
      setCanvas(null);
      setView(null);
    }
    setBusy(false);
    setError('Vorgang abgebrochen. Manuelle Erfassung bleibt möglich.');
  }

  async function openSource(id: string) {
    const chosen = sources.find((entry) => entry.id === id);
    if (!chosen) return;
    const revision = ++request.current;
    controller.current?.abort();
    setOpen(true);
    setBusy(true);
    setError(null);
    setResult(null);
    setCanvas(null);
    setSourceId(id);
    try {
      const loaded = await chosen.load();
      if (revision !== request.current) return;
      const image = await loadIdentityImage(loaded.blob);
      if (revision !== request.current) {
        image.dispose();
        return;
      }
      sourceRef.current?.dispose();
      sourceRef.current = image;
      setSource(image);
      const saved = initialViews.find(
        (entry) => entry.documentId === id && entry.versionId === loaded.versionId,
      );
      const next = saved ?? fullIdentityViewport(loaded.versionId, 'front');
      const rendered = await image.render(next.page);
      if (revision !== request.current) return;
      setView(next);
      setCanvas(rendered);
      setPreview(rendered.toDataURL('image/png'));
      setCroppedPreview(cropIdentityImage(rendered, next).toDataURL('image/png'));
    } catch (cause) {
      if (revision === request.current)
        setError(cause instanceof Error ? cause.message : 'Datei konnte nicht geöffnet werden.');
    } finally {
      if (revision === request.current) setBusy(false);
    }
  }

  function changeView(patch: Partial<IdentityViewport>) {
    if (!view || !canvas || busy) return;
    const next = { ...view, ...patch };
    setView(next);
    setResult(null);
    setSelected([]);
    setCroppedPreview(cropIdentityImage(canvas, next).toDataURL('image/png'));
  }
  async function changePage(page: number) {
    if (!source || !view || busy) return;
    const revision = ++request.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const rendered = await source.render(page);
      if (revision !== request.current) return;
      const next = { ...view, page, x: 0, y: 0, width: 1, height: 1 };
      setCanvas(rendered);
      setView(next);
      setPreview(rendered.toDataURL('image/png'));
      setCroppedPreview(cropIdentityImage(rendered, next).toDataURL('image/png'));
    } catch {
      if (revision === request.current)
        setError('PDF-Seite konnte nicht geöffnet werden. Bitte manuell fortfahren.');
    } finally {
      if (revision === request.current) setBusy(false);
    }
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const end = point(event);
    const start = drag.current;
    drag.current = null;
    const width = Math.abs(start.x - end.x);
    const height = Math.abs(start.y - end.y);
    if (width > 0.01 && height > 0.01)
      changeView({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height });
  }
  async function recognize() {
    if (!canvas || !view) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setResult(null);
    setSelected([]);
    setProgress(0);
    const timeout = window.setTimeout(() => abort.abort(), 120_000);
    try {
      const next = await recognizeIdentityImage(
        cropIdentityImage(canvas, view),
        abort.signal,
        setProgress,
      );
      if (!abort.signal.aborted) {
        // Bisherige Angaben (auch manuell eingegebene) gehen vor frühere Vorschläge.
        const crossCheck = next.mrz
          ? compareWithMrz({ ...lastFields.current, ...current }, next.mrz)
          : lastMrz.current
            ? compareWithMrz(next.fields, lastMrz.current)
            : [];
        if (next.mrz) lastMrz.current = next.mrz;
        else lastFields.current = next.fields;
        const seen = new Set<string>();
        const warnings: IdentityWarning[] = [
          ...next.warnings,
          ...crossCheck.map((warning) => ({ ...warning, acrossSides: true })),
        ].filter((warning) => {
          // „Datum von der Vorderseite übernehmen“ entfällt, wenn es schon
          // eingetragen ist; ein Widerspruch dazu meldet der Seitenabgleich.
          if (warning.code === 'mrz-date-century' && warning.field && current[warning.field])
            return false;
          const key = `${warning.code}:${warning.field ?? ''}:${warning.acrossSides ?? false}`;
          return !seen.has(key) && Boolean(seen.add(key));
        });
        setAppliedNote(null);
        setResult({ ...next, warnings });
      }
    } catch {
      setError(
        abort.signal.aborted
          ? 'Erkennung abgebrochen. Manuelle Erfassung bleibt möglich.'
          : 'Erkennung fehlgeschlagen. Bitte manuell erfassen oder den Ausschnitt verbessern.',
      );
    } finally {
      window.clearTimeout(timeout);
      controller.current = null;
      setBusy(false);
    }
  }

  if (!sources.length) return null;
  return (
    <section
      className="rounded-md border border-default bg-surface-raised p-3 space-y-3"
      aria-label="Lokale Ausweishilfe"
    >
      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() => {
          if (open) {
            if (busy) cancel();
            setOpen(false);
          } else void openSource(sourceId || sources[0]!.id);
        }}
      >
        {open ? 'Ausweishilfe schließen' : 'Ausweis zuschneiden und Daten erkennen'}
      </button>
      {open && (
        <>
          <p className="text-xs text-muted">{text.intro}</p>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs">
              Original
              <select
                className="input"
                value={sourceId}
                disabled={busy}
                onChange={(event) => void openSource(event.target.value)}
              >
                {sources.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {view && (
              <>
                <label className="text-xs">
                  Ausweisseite
                  <select
                    className="input"
                    value={view.side}
                    disabled={busy}
                    onChange={(event) =>
                      changeView({ side: event.target.value as 'front' | 'back' })
                    }
                  >
                    <option value="front">Vorderseite</option>
                    <option value="back">Rückseite</option>
                  </select>
                </label>
                {source && source.pages > 1 && (
                  <label className="text-xs">
                    PDF-Seite
                    <select
                      className="input"
                      value={view.page}
                      disabled={busy}
                      onChange={(event) => void changePage(Number(event.target.value))}
                    >
                      {Array.from({ length: source.pages }, (_, index) => (
                        <option key={index} value={index + 1}>
                          {index + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  className="btn-secondary text-xs"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    changeView({
                      rotation: ((view.rotation + 90) % 360) as IdentityViewport['rotation'],
                    })
                  }
                >
                  90° drehen
                </button>
                <button
                  className="btn-secondary text-xs"
                  type="button"
                  disabled={busy}
                  onClick={() => changeView({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })}
                >
                  Ganzes Original
                </button>
              </>
            )}
          </div>
          {view && canvas && (
            <>
              <p className="text-xs text-muted">
                Im Original einen Ausschnitt ziehen oder die Prozentwerte darunter einstellen.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div
                  className="relative self-start touch-none cursor-crosshair"
                  role="group"
                  aria-label="Original mit Ausschnitt"
                  onPointerDown={(event) => {
                    if (!busy) {
                      drag.current = point(event);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }
                  }}
                  onPointerUp={finishDrag}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                >
                  {/* Local memory-only images; no remote image optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview}
                    alt="Unveränderte Originalseite"
                    className="block w-full"
                    draggable={false}
                  />
                  <div
                    className="absolute border-2 border-blue-600 bg-blue-400/10 pointer-events-none"
                    style={{
                      left: `${view.x * 100}%`,
                      top: `${view.y * 100}%`,
                      width: `${view.width * 100}%`,
                      height: `${view.height * 100}%`,
                    }}
                  />
                </div>
                <div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={croppedPreview}
                    alt="Gedrehter Ausweisausschnitt"
                    className="w-full border border-default"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <label key={key} className="text-xs">
                    {{ x: 'Links %', y: 'Oben %', width: 'Breite %', height: 'Höhe %' }[key]}
                    <input
                      className="input"
                      type="number"
                      step="1"
                      min={key === 'width' || key === 'height' ? 1 : 0}
                      max={100}
                      value={Math.round(view[key] * 100)}
                      disabled={busy}
                      onChange={(event) => {
                        const minimum = key === 'width' || key === 'height' ? 0.01 : 0;
                        const value = Math.min(
                          1,
                          Math.max(minimum, Number(event.target.value) / 100),
                        );
                        const next = { ...view, [key]: value };
                        next.width = Math.min(next.width, 1 - next.x);
                        next.height = Math.min(next.height, 1 - next.y);
                        if (next.width > 0 && next.height > 0) changeView(next);
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={busy}
                  onClick={() => onViewChange({ ...view, documentId: sourceId })}
                >
                  Ausschnitt als {view.side === 'front' ? 'Vorderseite' : 'Rückseite'} übernehmen
                </button>
                <button
                  type="button"
                  className="btn-primary text-xs"
                  disabled={busy}
                  onClick={() => void recognize()}
                >
                  Daten erkennen
                </button>
              </div>
            </>
          )}
          {busy && (
            <div>
              <p className="text-xs" role="status">
                Ausweishilfe arbeitet… {progress > 0 ? `${Math.round(progress * 100)} %` : ''}
              </p>
              <button type="button" className="btn-secondary text-xs" onClick={cancel}>
                Erkennung abbrechen
              </button>
            </div>
          )}
          {error && (
            <p className="alert-error-sm" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div className="@container space-y-2">
              {result.warnings.map((warning) => (
                <p
                  className="text-xs text-amber-700"
                  key={`${warning.code}-${warning.field ?? ''}-${warning.acrossSides ?? false}`}
                >
                  {warningText(warning, audience)}
                </p>
              ))}
              {/* Ausweis neben den Vorschlägen: der Abgleich mit dem Original
                  ist der eigentliche Prüfschritt (GWG-OCR-ASSIST-001). */}
              <div className="grid gap-3 @lg:grid-cols-2">
                {croppedPreview && (
                  /* eslint-disable-next-line @next/next/no-img-element -- lokales Speicherbild */
                  <img
                    src={croppedPreview}
                    alt={text.imageAlt}
                    className="w-full self-start rounded border border-default"
                  />
                )}
                <div className="space-y-2">
                  <p className="text-xs text-muted">
                    {text.missing}{' '}
                    {Object.entries(IDENTITY_FIELD_LABELS)
                      .filter(
                        ([key]) =>
                          !result.fields[key as IdentityField] &&
                          // Mandanten: nur, was im Formular noch fehlt.
                          (audience === 'staff' || !current[key as IdentityField]),
                      )
                      .map(([, label]) => label)
                      .join(', ') || text.noneMissing}
                    .
                  </p>
                  <p className="text-xs font-medium">{text.compare}</p>
                  {(Object.entries(result.fields) as [IdentityField, string][]).map(
                    ([field, value]) => (
                      <label key={field} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.includes(field)}
                          onChange={(event) =>
                            setSelected((previous) =>
                              event.target.checked
                                ? [...previous, field]
                                : previous.filter((key) => key !== field),
                            )
                          }
                        />
                        <span>
                          {IDENTITY_FIELD_LABELS[field]}:{' '}
                          <strong>{displayValue(field, value, audience)}</strong>
                          {current[field] && current[field] !== value && (
                            <span className="block text-xs text-amber-700">
                              {text.previous(displayValue(field, current[field]!, audience))}
                            </span>
                          )}
                        </span>
                      </label>
                    ),
                  )}
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={!selected.length}
                    onClick={() => {
                      onApply(
                        Object.fromEntries(selected.map((field) => [field, result.fields[field]])),
                      );
                      setAppliedNote(
                        text.applied(selected.map((field) => IDENTITY_FIELD_LABELS[field])),
                      );
                      setSelected([]);
                      setResult(null);
                    }}
                  >
                    {text.apply}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* Live-Region existiert vor der Meldung, damit Screenreader sie ansagen. */}
          <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">
            {appliedNote}
          </p>
        </>
      )}
    </section>
  );
}
