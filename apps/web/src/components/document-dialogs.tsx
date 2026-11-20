'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { setDocumentFolderAction } from '@/app/staff/(protected)/documents/folder-actions';
import { retagDocumentsAction } from '@/app/staff/(protected)/documents/actions';
import { Modal } from '@/components/ui/modal';
import { FolderTreePicker } from '@/components/folder-tree-picker';
import {
  bulkResultMessage,
  descendants,
  type FolderNode,
} from '@/components/document-browser-utils';
import type { DocumentBulkResult } from '@/server/documents/document-bulk';

export type { FolderNode };

type RetagMany = (input: {
  documentIds: string[];
  documentTypeId: string;
}) => Promise<DocumentBulkResult>;

/**
 * P-18: Umklassifizierung einer Auswahl als eine Bulk-Action. Höherstufungen
 * mit Re-Store, die das Zeitbudget eines Aufrufs übersteigen, meldet der
 * Server als `pending`; sie werden mit dem nächsten Aufruf nachgereicht.
 */
export async function retagDocuments(
  documentIds: readonly string[],
  documentTypeId: string,
  retagMany: RetagMany = retagDocumentsAction,
): Promise<DocumentBulkResult> {
  const total: DocumentBulkResult = { ok: true, done: 0, rejected: [] };
  let remaining = [...documentIds];
  while (remaining.length > 0) {
    const result = await retagMany({ documentIds: remaining, documentTypeId });
    if (result.error) return { ...total, ok: false, error: result.error };
    total.done += result.done;
    total.rejected.push(...result.rejected);
    const pending = result.pending ?? [];
    // Der Server bearbeitet je Aufruf mindestens einen Re-Store; ohne
    // Fortschritt (unerwartet) nicht endlos wiederholen.
    if (pending.length >= remaining.length) {
      total.rejected.push(
        ...pending.map((id) => ({ id, error: 'Nicht verarbeitet. Bitte erneut versuchen.' })),
      );
      break;
    }
    remaining = pending;
  }
  return { ...total, ok: total.rejected.length === 0 };
}

// ===========================================================================
// MoveDialog — Ordner-Picker (Baum). Ersetzt das unintuitive Dropdown.
// `folders` ist bereits auf den Bereich des Dokuments (Mandant bzw.
// kanzlei-intern) eingegrenzt.
// ===========================================================================
export function MoveDialog({
  documentId,
  documentTitle,
  currentFolderId,
  folders,
  onClose,
  onDone,
}: {
  documentId: string;
  documentTitle: string;
  currentFolderId: string | null;
  folders: FolderNode[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<string | null>(currentFolderId);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <Modal title="Dokument verschieben" onClose={onClose} closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-1">Verschieben</h2>
      <p className="text-xs text-muted mb-3 truncate">„{documentTitle}"</p>
      <fieldset
        disabled={busy}
        className="border border-default rounded-md max-h-72 overflow-auto p-1"
      >
        <FolderTreePicker
          folders={folders}
          value={target}
          onSelect={setTarget}
          rootLabel="— Ohne Ordner (Wurzel) —"
          showCheck
          emptyLabel="Noch keine Ordner in diesem Bereich."
        />
      </fieldset>
      {err && (
        <div role="alert" className="rounded bg-red-50 p-2 text-xs text-red-700 mt-3">
          {err}
        </div>
      )}
      <div className="flex gap-2 mt-4">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy || target === currentFolderId}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await setDocumentFolderAction({ documentId, folderId: target }).catch(
                () => ({
                  ok: false,
                  error: 'Verschieben konnte nicht bestätigt werden. Bitte die Liste prüfen.',
                }),
              );
              if (r.ok) onDone();
              else setErr(r.error ?? 'Fehler.');
            })
          }
          className="btn-primary flex-1"
        >
          {busy ? 'Verschiebt…' : 'Hierher verschieben'}
        </button>
      </div>
    </Modal>
  );
}

// ===========================================================================
// RetagDialog — Datei-Typ ändern (compliance-bewusst, tier-basiert).
// Unterstützt EIN Dokument (mit clientseitiger Herabstufungs-Sperre, wenn
// `currentTier` bekannt) oder MEHRERE (Bulk: Herabstufungen werden server-
// seitig je Datei abgelehnt und am Ende zusammengefasst).
// ===========================================================================
type Tier = 'NONE' | 'GWG' | 'GOBD';
interface RetagType {
  id: string;
  name: string;
  tier: Tier;
  retentionYears: number | null;
  builtin: boolean;
}
const tierRank = (t: Tier): 0 | 1 | 2 => (t === 'GOBD' ? 2 : t === 'GWG' ? 1 : 0);
const tierShort = (type: RetagType) =>
  type.tier === 'NONE'
    ? 'kein Lock'
    : `${type.tier === 'GOBD' ? 'GoBD' : 'GwG'} ${type.retentionYears ?? '?'} J.`;

function useRetagTypes() {
  const [types, setTypes] = useState<RetagType[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    if (status !== 'loading') return;
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch('/api/staff/document-types', { signal: controller.signal });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { types: RetagType[] };
        if (!Array.isArray(data.types)) throw new Error('Ungültige Typauswahl');
        if (!controller.signal.aborted) {
          setTypes(data.types);
          setStatus('ready');
        }
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [status]);
  return { types, status, retry: () => setStatus('loading') };
}

function RetagTypesFeedback({
  status,
  retry,
}: Pick<ReturnType<typeof useRetagTypes>, 'status' | 'retry'>) {
  if (status === 'error')
    return (
      <div role="alert" className="px-2 py-2 text-xs">
        Datei-Typen konnten nicht geladen werden.{' '}
        <button type="button" className="underline" onClick={retry}>
          Erneut laden
        </button>
      </div>
    );
  return (
    <p role="status" className="px-2 py-2 text-xs text-muted">
      {status === 'loading' ? 'Lädt Typen…' : 'Keine Datei-Typen verfügbar.'}
    </p>
  );
}

export function RetagDialog({
  documentIds,
  documentTitle,
  currentTier,
  currentTypeId,
  onClose,
  onDone,
}: {
  documentIds: string[];
  documentTitle: string;
  /** Nur bei Einzel-Dokument bekannt — sperrt Herabstufungen clientseitig. */
  currentTier?: Tier;
  currentTypeId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const multi = documentIds.length > 1 || currentTier === undefined;
  const { types, status, retry } = useRetagTypes();
  const [sel, setSel] = useState<string>(currentTypeId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const curRank = currentTier ? tierRank(currentTier) : 0;
  const selType = types.find((t) => t.id === sel);
  const selRank = selType ? tierRank(selType.tier) : curRank;
  const isDowngrade = !multi && selRank < curRank;
  const isRestore = !multi && selRank > curRank;

  return (
    <Modal title="Datei-Typ ändern" onClose={onClose} closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-1">
        Typ ändern{multi ? ` — ${documentIds.length} Dokument(e)` : ''}
      </h2>
      <p className="text-xs text-muted mb-3 truncate">
        {multi
          ? 'Herabstufungen (GoBD/GwG → schwächer) werden serverseitig je Datei abgelehnt und am Ende zusammengefasst.'
          : `„${documentTitle}"`}
      </p>
      <div className="space-y-1 mb-3 max-h-64 overflow-auto">
        {types.length === 0 && <RetagTypesFeedback status={status} retry={retry} />}
        {types.map((t) => {
          const down = !multi && tierRank(t.tier) < curRank;
          return (
            <label
              key={t.id}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                down ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50'
              } ${sel === t.id ? 'bg-brand-50 text-brand-700' : 'text-secondary'}`}
            >
              <input
                type="radio"
                name="retag"
                value={t.id}
                checked={sel === t.id}
                disabled={down || busy}
                onChange={() => setSel(t.id)}
              />
              <span className="flex-1">{t.name}</span>
              <span className="text-xs text-disabled">{tierShort(t)}</span>
              {!multi && t.id === currentTypeId && (
                <span className="text-xs text-disabled">aktuell</span>
              )}
              {down && <span className="text-xs text-red-500">gesperrt</span>}
            </label>
          );
        })}
      </div>
      {isDowngrade && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-700 mb-3">
          Herabstufung nicht möglich: Eine angewandte gesetzliche Aufbewahrung (Object-Lock) lässt
          sich nicht entfernen.
        </div>
      )}
      {isRestore && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-3">
          Höherstufung: Die Datei wird in den revisionssicheren Bucket umkopiert (Object-Lock +
          gesetzliche Aufbewahrung) und erneut virengeprüft. Vorgang wird im Audit-Log
          protokolliert.
        </div>
      )}
      {err && (
        <div
          role="alert"
          className={`rounded p-2 text-xs mb-3 whitespace-pre-line ${
            multi ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {err}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy || !selType || (!multi && (sel === currentTypeId || isDowngrade))}
          onClick={() =>
            start(async () => {
              setErr(null);
              const result = await retagDocuments(documentIds, sel).catch(() => ({
                done: 0,
                rejected: [],
                error: 'Die Typänderung konnte nicht bestätigt werden. Bitte die Liste prüfen.',
              }));
              const message = bulkResultMessage(result, documentIds.length, 'geändert');
              if (message) setErr(message);
              else onDone();
            })
          }
          className="btn-primary flex-1"
        >
          {busy ? 'Ändert…' : multi ? 'Anwenden' : 'Typ ändern'}
        </button>
      </div>
    </Modal>
  );
}

// ===========================================================================
// MoveTargetDialog — Ziel-Ordner für eine AUSWAHL (Dateien + Ordner) wählen.
// Anders als MoveDialog (ein Dokument, führt selbst aus) liefert dieser nur
// das Ziel zurück; das Verschieben übernimmt der Aufrufer (Bulk/DnD).
// ===========================================================================
export function MoveTargetDialog({
  folders,
  movingFolderIds,
  onClose,
  onPick,
  busy,
}: {
  folders: FolderNode[];
  movingFolderIds: string[];
  onClose: () => void;
  onPick: (target: string | null) => void;
  busy: boolean;
}) {
  const [target, setTarget] = useState<string | null>(null);
  // Ziele, die im Teilbaum eines zu verschiebenden Ordners liegen, sperren.
  const blocked = useMemo(() => descendants(folders, movingFolderIds), [folders, movingFolderIds]);

  return (
    <Modal title="Verschieben nach…" onClose={onClose} closeDisabled={busy}>
      <h2 className="text-base font-semibold text-primary mb-3">Verschieben nach…</h2>
      <fieldset
        disabled={busy}
        className="border border-default rounded-md max-h-72 overflow-auto p-1"
      >
        <FolderTreePicker
          folders={folders}
          value={target}
          onSelect={setTarget}
          rootLabel="— Wurzel (ohne Ordner) —"
          disabledIds={blocked}
          showCheck
        />
      </fieldset>
      <div className="flex gap-2 mt-4">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => onPick(target)}
          disabled={busy || (target !== null && blocked.has(target))}
          className="btn-primary flex-1"
        >
          {busy ? 'Verschiebt…' : 'Hierher verschieben'}
        </button>
      </div>
    </Modal>
  );
}
