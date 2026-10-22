'use client';

import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import {
  compareWithMrz,
  detectedSide,
  IDENTITY_FIELD_LABELS,
  type IdentityField,
  type IdentityOcrResult,
  type IdentitySuggestions,
  type IdentityWarning,
} from '@/lib/gwg/identity-ocr';
import {
  IDENTITY_UI_TEXT,
  warningText,
  warningTone,
  type IdentityAudience,
} from '@/lib/gwg/identity-hints';
import { suggestionRows } from '@/lib/gwg/identity-suggestions';
import { countryName } from '@/lib/countries';
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

type IdentitySide = IdentityViewport['side'];

const DATE_FIELDS: ReadonlySet<IdentityField> = new Set([
  'birthDate',
  'idIssueDate',
  'idExpiryDate',
]);

/** Mandanten sehen Daten wie auf dem Ausweis (TT.MM.JJJJ); übernommen wird ISO. */
function displayValue(field: IdentityField, value: string, audience: IdentityAudience): string {
  // Staatsangehörigkeit als Ländername („DE, TR“ → „Deutschland, Türkei“).
  if (field === 'nationality')
    return value
      .split(',')
      .map((part) => countryName(part) ?? part.trim())
      .join(', ');
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return audience === 'client' && DATE_FIELDS.has(field) && iso
    ? `${iso[3]}.${iso[2]}.${iso[1]}`
    : value;
}

const SIDE_LABEL = { front: 'Vorderseite', back: 'Rückseite' } as const;

/** Hinweis, wenn der Inhalt nach der anderen Ausweisseite aussieht als gewählt. */
function sideMismatch(result: IdentityOcrResult, chosen: IdentitySide): IdentityWarning[] {
  const side = detectedSide(result);
  if (!side || side === chosen) return [];
  return [
    {
      code: 'side-mismatch',
      side,
      text: `Der Inhalt sieht nach der ${SIDE_LABEL[side]} aus, gewählt ist die ${SIDE_LABEL[chosen]}. Ausweisseite bzw. Zuordnung der Dateien prüfen.`,
    },
  ];
}

/** Widersprüche auffällig, übrige Hinweise ruhig – ein gut gelesener Ausweis ist kein Fehler. */
function WarningList({
  warnings,
  audience,
}: {
  warnings: IdentityWarning[];
  audience: IdentityAudience;
}) {
  const key = (warning: IdentityWarning) =>
    `${warning.code}-${warning.field ?? ''}-${warning.acrossSides ?? false}`;
  const attention = warnings.filter((warning) => warningTone(warning) === 'attention');
  const info = warnings.filter((warning) => warningTone(warning) === 'info');
  return (
    <>
      {attention.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          {attention.map((warning) => (
            <p key={key(warning)}>{warningText(warning, audience)}</p>
          ))}
        </div>
      )}
      {info.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          {info.map((warning) => (
            <li key={key(warning)}>{warningText(warning, audience)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Vorschläge zum Anhaken, in üblicher Schreibweise. Was der bisherigen Angabe
 * bis auf Groß-/Kleinschreibung oder Umlaute entspricht, erscheint nur als Hinweis.
 */
export function SuggestionChoices({
  fields,
  derived,
  current,
  audience,
  selected,
  onSelect,
  onApply,
}: {
  fields: IdentitySuggestions;
  /** Ausweisfassung abgeleiteter Werte (ergänztes Jahr). */
  derived?: IdentityOcrResult['printed'];
  current: IdentitySuggestions;
  audience: IdentityAudience;
  selected: IdentityField[];
  onSelect: (field: IdentityField, checked: boolean) => void;
  onApply: (values: IdentitySuggestions) => void;
}) {
  const text = IDENTITY_UI_TEXT[audience];
  const rowId = useId();
  const { offered, matching } = suggestionRows(fields, current, derived);
  return (
    <>
      {matching.length > 0 && (
        <p className="text-xs text-muted">
          {text.matching(matching.map((field) => IDENTITY_FIELD_LABELS[field]))}
        </p>
      )}
      {offered.length > 0 && <p className="text-xs font-medium">{text.compare}</p>}
      {offered.map(({ field, value, printed, adjusted }) => {
        // Hinweise als Beschreibung: der Name der Checkbox bleibt „Feld: Wert“.
        const notes = [
          printed && {
            id: `${rowId}-${field}-printed`,
            text: adjusted === 'year' ? text.yearCompleted(printed) : text.printed(printed),
            tone: 'text-muted',
          },
          current[field] && {
            id: `${rowId}-${field}-previous`,
            text: text.previous(displayValue(field, current[field]!, audience)),
            tone: 'text-amber-700',
          },
        ].filter((note) => typeof note === 'object');
        return (
          <div key={field} className="text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={selected.includes(field)}
                aria-describedby={notes.map((note) => note.id).join(' ') || undefined}
                onChange={(event) => onSelect(field, event.target.checked)}
              />
              <span>
                {IDENTITY_FIELD_LABELS[field]}:{' '}
                <strong>{displayValue(field, value, audience)}</strong>
              </span>
            </label>
            {notes.map((note) => (
              <p key={note.id} id={note.id} className={`ml-6 text-xs ${note.tone}`}>
                {note.text}
              </p>
            ))}
          </div>
        );
      })}
      {offered.length > 0 && (
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!selected.length}
          onClick={() => {
            const values = new Map(offered.map((row) => [row.field, row.value]));
            onApply(Object.fromEntries(selected.map((field) => [field, values.get(field)])));
          }}
        >
          {text.apply}
        </button>
      )}
    </>
  );
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
  sideSources,
}: {
  sources: IdentityCaptureSource[];
  current: IdentitySuggestions;
  onApply: (fields: IdentitySuggestions) => void;
  onViewChange: (view: IdentitySourceView) => void;
  initialViews?: IdentitySourceView[];
  /** Mandanten im öffentlichen Onboarding erhalten verständliche Texte. */
  audience?: IdentityAudience;
  /**
   * Original je Ausweisseite. Mandanten lesen eine Seite dann mit einem Klick
   * aus; Original, Seite und Ausschnitt liegen eingeklappt unter
   * „Ausschnitt anpassen“.
   */
  sideSources?: Partial<Record<IdentitySide, string>>;
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

  async function openSource(
    id: string,
    side?: IdentitySide,
  ): Promise<{ canvas: HTMLCanvasElement; view: IdentityViewport } | null> {
    const chosen = sources.find((entry) => entry.id === id);
    if (!chosen) return null;
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
      if (revision !== request.current) return null;
      const image = await loadIdentityImage(loaded.blob);
      if (revision !== request.current) {
        image.dispose();
        return null;
      }
      sourceRef.current?.dispose();
      sourceRef.current = image;
      setSource(image);
      const saved = initialViews.find(
        (entry) =>
          entry.documentId === id &&
          entry.versionId === loaded.versionId &&
          (!side || entry.side === side),
      );
      const next = saved ?? fullIdentityViewport(loaded.versionId, side ?? 'front');
      const rendered = await image.render(next.page);
      if (revision !== request.current) return null;
      setView(next);
      setCanvas(rendered);
      setPreview(rendered.toDataURL('image/png'));
      setCroppedPreview(cropIdentityImage(rendered, next).toDataURL('image/png'));
      return { canvas: rendered, view: next };
    } catch (cause) {
      if (revision === request.current)
        setError(cause instanceof Error ? cause.message : 'Datei konnte nicht geöffnet werden.');
      return null;
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
  /** Mandanten: Seite öffnen und auslesen; ein angepasster Ausschnitt dieser Seite bleibt. */
  async function readSide(side: IdentitySide) {
    const id = sideSources?.[side];
    if (!id || busy) return;
    const target =
      id === sourceId && view?.side === side && canvas
        ? { canvas, view }
        : await openSource(id, side);
    if (target) await recognize(target);
  }
  async function recognize(target = canvas && view ? { canvas, view } : null) {
    if (!target) return;
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
        cropIdentityImage(target.canvas, target.view),
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
        const { matching } = suggestionRows(next.fields, current, next.printed);
        const warnings: IdentityWarning[] = [
          ...sideMismatch(next, target.view.side),
          ...next.warnings,
          ...crossCheck.map((warning) => ({ ...warning, acrossSides: true })),
        ].filter((warning) => {
          // „Datum von der Vorderseite übernehmen“ entfällt, wenn es schon
          // eingetragen ist; ein Widerspruch dazu meldet der Seitenabgleich.
          if (warning.code === 'mrz-date-century' && warning.field && current[warning.field])
            return false;
          // Schreibweisenhinweis zum Namen entfällt, wenn der Name nicht
          // angeboten wird, weil er der bisherigen Angabe entspricht.
          if (warning.code === 'mrz-name' && matching.includes('fullName')) return false;
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
  const sides = (['front', 'back'] as const).filter((side) => sideSources?.[side]);
  const simple = audience === 'client' && sides.length > 0;
  // Original, Seite, Drehung und Ausschnitt; für Mandanten eingeklappt.
  const viewControls = () => (
    <>
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
                onChange={(event) => changeView({ side: event.target.value as 'front' | 'back' })}
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
                    const value = Math.min(1, Math.max(minimum, Number(event.target.value) / 100));
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
    </>
  );
  return (
    <section
      className="rounded-md border border-default bg-surface-raised p-3 space-y-3"
      aria-label="Lokale Ausweishilfe"
    >
      {simple ? (
        <>
          <p className="text-xs text-muted">{text.intro}</p>
          <div className="flex flex-wrap gap-2">
            {sides.map((side) => (
              <button
                key={side}
                type="button"
                className="btn-secondary text-xs"
                disabled={busy}
                onClick={() => void readSide(side)}
              >
                {side === 'front' ? 'Vorderseite auslesen' : 'Rückseite auslesen'}
              </button>
            ))}
          </div>
          {open && view && (
            <details className="text-xs">
              <summary className="cursor-pointer text-secondary">Ausschnitt anpassen</summary>
              <div className="mt-3 space-y-3">{viewControls()}</div>
            </details>
          )}
        </>
      ) : (
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
      )}
      {open && (
        <>
          {!simple && <p className="text-xs text-muted">{text.intro}</p>}
          {!simple && viewControls()}
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
              <WarningList warnings={result.warnings} audience={audience} />
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
                  <SuggestionChoices
                    fields={result.fields}
                    derived={result.printed}
                    current={current}
                    audience={audience}
                    selected={selected}
                    onSelect={(field, checked) =>
                      setSelected((previous) =>
                        checked ? [...previous, field] : previous.filter((key) => key !== field),
                      )
                    }
                    onApply={(values) => {
                      onApply(values);
                      setAppliedNote(
                        text.applied(
                          (Object.keys(values) as IdentityField[]).map(
                            (field) => IDENTITY_FIELD_LABELS[field],
                          ),
                        ),
                      );
                      setSelected([]);
                      setResult(null);
                    }}
                  />
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
