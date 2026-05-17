'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, ChevronRight, ChevronDown, X, Check } from 'lucide-react';
import {
  setDocumentFolderAction,
} from '@/app/staff/(protected)/documents/folder-actions';
import { retagDocumentAction } from '@/app/staff/(protected)/documents/actions';

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

function Portal({ children }: { children: React.ReactNode }) {
  return typeof document !== 'undefined' ? createPortal(children, document.body) : null;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderNode[]>();
    for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    }
    return m;
  }, [folders]);

  function row(f: FolderNode, depth: number) {
    const kids = childrenOf.get(f.id) ?? [];
    const open = expanded[f.id];
    const isTarget = target === f.id;
    return (
      <div key={f.id}>
        <div
          className={`flex items-center gap-1 rounded px-2 py-1.5 text-sm cursor-pointer ${
            isTarget ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-gray-700'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setTarget(f.id)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => ({ ...x, [f.id]: !x[f.id] }));
            }}
            className={kids.length ? 'text-gray-400' : 'invisible'}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {isTarget ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
          <span className="truncate flex-1">{f.name}</span>
          {isTarget && <Check className="h-3.5 w-3.5" />}
        </div>
        {open && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
        <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={onClose} className="absolute top-3 right-3 text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Verschieben</h2>
          <p className="text-xs text-gray-500 mb-3 truncate">„{documentTitle}"</p>
          <div className="border border-gray-200 rounded-md max-h-72 overflow-auto p-1">
            <div
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer ${
                target === null ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-gray-700'
              }`}
              onClick={() => setTarget(null)}
            >
              <Folder className="h-4 w-4 text-gray-300" />
              <span className="flex-1">— Ohne Ordner (Wurzel) —</span>
              {target === null && <Check className="h-3.5 w-3.5" />}
            </div>
            {(childrenOf.get(null) ?? []).map((f) => row(f, 0))}
            {folders.length === 0 && (
              <p className="px-2 py-3 text-xs text-gray-400">
                Noch keine Ordner in diesem Bereich.
              </p>
            )}
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
        </div>
      </div>
    </Portal>
  );
}

// ===========================================================================
// RetagDialog — Datei-Typ ändern (compliance-bewusst, tier-basiert).
// ===========================================================================
type Tier = 'NONE' | 'GWG' | 'GOBD';
interface RetagType { id: string; name: string; tier: Tier; builtin: boolean }
const tierRank = (t: Tier): 0 | 1 | 2 => (t === 'GOBD' ? 2 : t === 'GWG' ? 1 : 0);
const tierShort = (t: Tier) => (t === 'GOBD' ? 'GoBD 10 J.' : t === 'GWG' ? 'GwG 5 J.' : 'kein Lock');

export function RetagDialog({
  documentId,
  documentTitle,
  currentTier,
  currentTypeId,
  onClose,
  onDone,
}: {
  documentId: string;
  documentTitle: string;
  currentTier: Tier;
  currentTypeId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
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

  const curRank = tierRank(currentTier);
  const selType = types.find((t) => t.id === sel);
  const selRank = selType ? tierRank(selType.tier) : curRank;
  const isDowngrade = selRank < curRank;
  const isRestore = selRank > curRank;

  return (
    <Portal>
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
        <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={onClose} className="absolute top-3 right-3 text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Typ ändern</h2>
          <p className="text-xs text-gray-500 mb-3 truncate">„{documentTitle}"</p>
          <div className="space-y-1 mb-3 max-h-64 overflow-auto">
            {types.length === 0 && (
              <p className="px-2 py-2 text-xs text-gray-400">Lädt Typen…</p>
            )}
            {types.map((t) => {
              const down = tierRank(t.tier) < curRank;
              return (
                <label
                  key={t.id}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                    down ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50'
                  } ${sel === t.id ? 'bg-brand-50 text-brand-700' : 'text-gray-700'}`}
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
                  <span className="text-xs text-gray-400">{tierShort(t.tier)}</span>
                  {t.id === currentTypeId && <span className="text-xs text-gray-400">aktuell</span>}
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
          {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">{err}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
              Abbrechen
            </button>
            <button
              type="button"
              disabled={busy || !sel || sel === currentTypeId || isDowngrade}
              onClick={() =>
                start(async () => {
                  setErr(null);
                  const r = await retagDocumentAction({ documentId, documentTypeId: sel });
                  if (r.ok) onDone();
                  else setErr(r.error ?? 'Fehler.');
                })
              }
              className="btn-primary flex-1"
            >
              {busy ? 'Ändert…' : 'Typ ändern'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
