'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  setDocumentFolderAction,
} from '@/app/staff/(protected)/documents/folder-actions';
import { retagDocumentAction } from '@/app/staff/(protected)/documents/actions';
import { Modal } from '@/components/ui/modal';
import { FolderTreePicker } from '@/components/folder-tree-picker';
import { runChunked, type FolderNode } from '@/components/document-browser-utils';

export type { FolderNode };

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
    <Modal title="Dokument verschieben" onClose={onClose}>
      <h2 className="text-base font-semibold text-primary mb-1">Verschieben</h2>
      <p className="text-xs text-muted mb-3 truncate">„{documentTitle}"</p>
      <div className="border border-default rounded-md max-h-72 overflow-auto p-1">
        <FolderTreePicker
          folders={folders}
          value={target}
          onSelect={setTarget}
          rootLabel="— Ohne Ordner (Wurzel) —"
          showCheck
          emptyLabel="Noch keine Ordner in diesem Bereich."
        />
      </div>
      {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mt-3">{err}</div>}
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
              const r = await setDocumentFolderAction({ documentId, folderId: target });
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
interface RetagType { id: string; name: string; tier: Tier; builtin: boolean }
const tierRank = (t: Tier): 0 | 1 | 2 => (t === 'GOBD' ? 2 : t === 'GWG' ? 1 : 0);
const tierShort = (t: Tier) => (t === 'GOBD' ? 'GoBD 10 J.' : t === 'GWG' ? 'GwG 5 J.' : 'kein Lock');

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
  const [types, setTypes] = useState<RetagType[]>([]);
  const [sel, setSel] = useState<string>(currentTypeId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/staff/document-types');
        if (!res.ok) return;
        const data = (await res.json()) as { types: RetagType[] };
        if (!cancelled) setTypes(data.types);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const curRank = currentTier ? tierRank(currentTier) : 0;
  const selType = types.find((t) => t.id === sel);
  const selRank = selType ? tierRank(selType.tier) : curRank;
  const isDowngrade = !multi && selRank < curRank;
  const isRestore = !multi && selRank > curRank;

  return (
    <Modal title="Datei-Typ ändern" onClose={onClose}>
      <h2 className="text-base font-semibold text-primary mb-1">
        Typ ändern{multi ? ` — ${documentIds.length} Dokument(e)` : ''}
      </h2>
      <p className="text-xs text-muted mb-3 truncate">
        {multi
          ? 'Herabstufungen (GoBD/GwG → schwächer) werden serverseitig je Datei abgelehnt und am Ende zusammengefasst.'
          : `„${documentTitle}"`}
      </p>
      <div className="space-y-1 mb-3 max-h-64 overflow-auto">
        {types.length === 0 && (
          <p className="px-2 py-2 text-xs text-disabled">Lädt Typen…</p>
        )}
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
                disabled={down}
                onChange={() => setSel(t.id)}
              />
              <span className="flex-1">{t.name}</span>
              <span className="text-xs text-disabled">{tierShort(t.tier)}</span>
              {!multi && t.id === currentTypeId && <span className="text-xs text-disabled">aktuell</span>}
              {down && <span className="text-xs text-red-500">gesperrt</span>}
            </label>
          );
        })}
      </div>
      {isDowngrade && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-700 mb-3">
          Herabstufung nicht möglich: Eine angewandte gesetzliche Aufbewahrung
          (Object-Lock) lässt sich nicht entfernen.
        </div>
      )}
      {isRestore && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-3">
          Höherstufung: Die Datei wird in den revisionssicheren Bucket
          umkopiert (Object-Lock + gesetzliche Aufbewahrung) und erneut
          virengeprüft. Vorgang wird im Audit-Log protokolliert.
        </div>
      )}
      {err && (
        <div
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
          disabled={busy || !sel || (!multi && (sel === currentTypeId || isDowngrade))}
          onClick={() =>
            start(async () => {
              setErr(null);
              const errs = await runChunked(documentIds, async (id) => {
                const r = await retagDocumentAction({ documentId: id, documentTypeId: sel });
                return r.ok ? null : (r.error ?? 'Fehler');
              });
              if (errs.length === 0) {
                onDone();
              } else if (documentIds.length === 1) {
                setErr(errs[0] ?? 'Fehler.');
              } else {
                setErr(
                  `${documentIds.length - errs.length} geändert, ${errs.length} abgelehnt:\n${[...new Set(errs)].join('\n')}`,
                );
              }
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
