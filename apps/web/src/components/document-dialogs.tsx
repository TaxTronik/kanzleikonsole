'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { setDocumentFolderAction } from '@/app/staff/(protected)/documents/folder-actions';
import {
  retagDocumentAction,
  softDeleteDocumentAction,
} from '@/app/staff/(protected)/documents/actions';
import { Modal } from '@/components/ui/modal';
import { FolderTreePicker } from '@/components/folder-tree-picker';
import { descendants, runChunked, type FolderNode } from '@/components/document-browser-utils';

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
    return () => {
      cancelled = true;
    };
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
        {types.length === 0 && <p className="px-2 py-2 text-xs text-disabled">Lädt Typen…</p>}
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
}: {
  folders: FolderNode[];
  movingFolderIds: string[];
  onClose: () => void;
  onPick: (target: string | null) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  // Ziele, die im Teilbaum eines zu verschiebenden Ordners liegen, sperren.
  const blocked = useMemo(() => {
    const b = new Set<string>();
    for (const id of movingFolderIds) for (const d of descendants(folders, id)) b.add(d);
    return b;
  }, [folders, movingFolderIds]);

  return (
    <Modal title="Verschieben nach…" onClose={onClose}>
      <h2 className="text-base font-semibold text-primary mb-3">Verschieben nach…</h2>
      <div className="border border-default rounded-md max-h-72 overflow-auto p-1">
        <FolderTreePicker
          folders={folders}
          value={target}
          onSelect={setTarget}
          rootLabel="— Wurzel (ohne Ordner) —"
          disabledIds={blocked}
          showCheck
        />
      </div>
      <div className="flex gap-2 mt-4">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button type="button" onClick={() => onPick(target)} className="btn-primary flex-1">
          Hierher verschieben
        </button>
      </div>
    </Modal>
  );
}

// ===========================================================================
// DeleteDocModal — Soft-Delete MIT optionalem Grund + GoBD/GwG-Aufklärung
// (Einsatz im Embedded-Modus des DocumentExplorer).
// ===========================================================================
export function DeleteDocModal({
  doc,
  onClose,
  onDone,
}: {
  doc: { id: string; title: string; classification: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const gobd = doc.classification.startsWith('GOBD_');
  const gwg = doc.classification === 'GWG_EVIDENCE';
  return (
    <Modal title="Dokument löschen" onClose={onClose}>
      <h2 className="text-lg font-semibold text-primary mb-2">Dokument löschen</h2>
      <p className="text-sm text-secondary mb-3">„{doc.title}" wird aus den Listen ausgeblendet.</p>
      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-4">
        Die Datei wird hier nur aus den Listen ausgeblendet.
        {gobd
          ? ' Der COMPLIANCE-Lock bewahrt sie bis zum hinterlegten Fristende auf.'
          : gwg
            ? ' Die endgültige GwG-Vernichtung erfolgt ausschließlich über die Fristenprüfung.'
            : ' Dieser Vorgang entfernt die gespeicherten Bytes nicht.'}{' '}
        Protokolliert im Audit-Log, wiederherstellbar.
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="input mb-3"
        placeholder="Grund (optional)"
      />
      {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">{err}</div>}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await softDeleteDocumentAction({
                documentId: doc.id,
                reason: reason.trim() || undefined,
              });
              if (r.ok) onDone();
              else setErr(r.error ?? 'Fehler.');
            })
          }
          className="btn-primary flex-1 !bg-red-600 hover:!bg-red-700"
        >
          {busy ? 'Löscht…' : 'Löschen'}
        </button>
      </div>
    </Modal>
  );
}
