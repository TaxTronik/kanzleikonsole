'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Pencil, Lock, ShieldCheck, Shield, FileText } from 'lucide-react';
import {
  createDocumentTypeAction,
  updateDocumentTypeAction,
  deleteDocumentTypeAction,
} from './actions';

type Tier = 'NONE' | 'GWG' | 'GOBD';

interface DocType {
  id: string;
  name: string;
  tier: Tier;
  builtin: boolean;
  active: boolean;
  docCount: number;
}

const TIER_LABEL: Record<Tier, string> = {
  NONE: 'Kein Lock',
  GWG: 'GwG · 5 Jahre',
  GOBD: 'GoBD · 10 Jahre',
};

function TierBadge({ tier }: { tier: Tier }) {
  const cls =
    tier === 'GOBD'
      ? 'bg-red-50 text-red-700 border-red-200'
      : tier === 'GWG'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-gray-50 text-secondary border-default';
  const Icon = tier === 'NONE' ? Shield : ShieldCheck;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${cls}`}>
      <Icon className="h-3 w-3" />
      {TIER_LABEL[tier]}
    </span>
  );
}

export function DocumentTypeEditor({ initial }: { initial: DocType[] }) {
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTier, setNewTier] = useState<Tier>('NONE');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  function create() {
    setError(null);
    start(async () => {
      const r = await createDocumentTypeAction({ name: newName.trim(), tier: newTier });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setCreating(false);
      setNewName('');
      setNewTier('NONE');
    });
  }
  function saveEdit(t: DocType, active: boolean) {
    setError(null);
    start(async () => {
      const r = await updateDocumentTypeAction({
        id: t.id,
        name: (editId === t.id ? editName : t.name).trim(),
        active,
      });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setEditId(null);
    });
  }
  function remove(t: DocType) {
    if (t.docCount > 0) {
      alert(`„${t.name}" wird von ${t.docCount} Dokument(en) genutzt — bitte deaktivieren statt löschen.`);
      return;
    }
    if (!confirm(`Typ „${t.name}" löschen?`)) return;
    setError(null);
    start(async () => {
      const r = await deleteDocumentTypeAction({ id: t.id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="space-y-4">
      {error && <div className="alert-error-sm">{error}</div>}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Typ</th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Schutzstufe</th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Dokumente</th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Status</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {initial.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-primary">
                  {editId === t.id ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="input !py-1 text-sm"
                      maxLength={120}
                    />
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {t.builtin && <Lock className="h-3.5 w-3.5 text-disabled" />}
                      {t.name}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3"><TierBadge tier={t.tier} /></td>
                <td className="px-5 py-3 text-muted">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5 text-disabled" />
                    {t.docCount}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {t.active ? (
                    <span className="badge-green">aktiv</span>
                  ) : (
                    <span className="badge-yellow">inaktiv</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  {t.builtin ? (
                    <span className="text-xs text-disabled">Kern-Typ (fix)</span>
                  ) : editId === t.id ? (
                    <>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => saveEdit(t, t.active)}
                        className="btn-primary text-xs py-1 mr-1"
                      >
                        Speichern
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditId(null)}
                        className="btn-secondary text-xs py-1"
                      >
                        Abbrechen
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        title={t.active ? 'Deaktivieren' : 'Aktivieren'}
                        disabled={isPending}
                        onClick={() => saveEdit(t, !t.active)}
                        className="text-xs text-muted hover:text-primary mr-2"
                      >
                        {t.active ? 'Deaktivieren' : 'Aktivieren'}
                      </button>
                      <button
                        type="button"
                        title="Umbenennen"
                        onClick={() => {
                          setEditId(t.id);
                          setEditName(t.name);
                        }}
                        className="text-disabled hover:text-brand-700 p-1"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Löschen"
                        onClick={() => remove(t)}
                        className="text-disabled hover:text-red-600 p-1"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating ? (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="dt-name">Name</label>
              <input
                id="dt-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input"
                maxLength={120}
                placeholder="z. B. Arbeitspapiere"
              />
            </div>
            <div>
              <label className="label" htmlFor="dt-tier">Schutzstufe (danach fix)</label>
              <select
                id="dt-tier"
                value={newTier}
                onChange={(e) => setNewTier(e.target.value as Tier)}
                className="input"
              >
                <option value="NONE">Kein Lock</option>
                <option value="GWG">GwG · 5 Jahre</option>
                <option value="GOBD">GoBD · 10 Jahre</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-muted">
            Die Schutzstufe lässt sich nach Anlage nicht mehr ändern (sonst
            müssten alle bereits abgelegten Dokumente dieses Typs umkopiert
            werden). Für eine andere Stufe einen neuen Typ anlegen.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isPending || !newName.trim()}
              onClick={create}
              className="btn-primary text-sm"
            >
              {isPending ? 'Legt an…' : 'Typ anlegen'}
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="btn-secondary text-sm"
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setCreating(true)} className="btn-secondary text-sm">
          <Plus className="h-4 w-4" />
          Eigenen Typ anlegen
        </button>
      )}
    </div>
  );
}
