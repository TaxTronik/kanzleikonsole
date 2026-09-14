'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Pencil, Lock, ShieldCheck, Shield, FileText } from 'lucide-react';
import {
  createDocumentTypeAction,
  updateDocumentTypeAction,
  deleteDocumentTypeAction,
} from './actions';
import { confirmDialog, noticeDialog } from '@/components/ui/modal';

type Tier = 'NONE' | 'GWG' | 'GOBD';

interface DocType {
  id: string;
  name: string;
  tier: Tier;
  retentionYears: number | null;
  builtin: boolean;
  active: boolean;
  docCount: number;
}

const TIER_LABEL: Record<Tier, string> = {
  NONE: 'Kein Lock',
  GWG: 'GwG · 5 J. + Prüfung',
  GOBD: 'GoBD · typabhängig',
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
  const [newRetentionYears, setNewRetentionYears] = useState<6 | 8 | 10>(10);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  function create() {
    setError(null);
    start(async () => {
      const r = await createDocumentTypeAction({
        name: newName.trim(),
        tier: newTier,
        ...(newTier === 'GOBD' ? { retentionYears: newRetentionYears } : {}),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
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
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setEditId(null);
    });
  }
  async function remove(t: DocType) {
    if (t.docCount > 0) {
      await noticeDialog(
        `„${t.name}" wird von ${t.docCount} Dokument(en) genutzt — bitte deaktivieren statt löschen.`,
        { title: 'Dokumenttyp wird verwendet' },
      );
      return;
    }
    if (
      !(await confirmDialog(`Typ „${t.name}" löschen?`, {
        title: 'Dokumenttyp löschen',
        confirmLabel: 'Löschen',
        danger: true,
      }))
    )
      return;
    setError(null);
    start(async () => {
      const r = await deleteDocumentTypeAction({ id: t.id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="min-w-0 space-y-4">
      {error && (
        <div className="alert-error-sm" role="alert">
          {error}
        </div>
      )}

      <div
        className="card overflow-x-auto"
        role="region"
        aria-label="Datei-Typen"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Horizontale Tabellenspalten müssen per Tastatur erreichbar sein.
        tabIndex={0}
      >
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                Typ
              </th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                Schutzstufe
              </th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                Aufbewahrung
              </th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                Dokumente
              </th>
              <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                Status
              </th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {initial.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="min-w-56 max-w-80 px-5 py-3 font-medium text-primary [overflow-wrap:anywhere]">
                  {editId === t.id ? (
                    <>
                      <label className="label" htmlFor={`document-type-name-${t.id}`}>
                        Name
                      </label>
                      <input
                        id={`document-type-name-${t.id}`}
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="input min-w-0 !py-1 text-sm"
                        maxLength={120}
                      />
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {t.builtin && <Lock className="h-3.5 w-3.5 shrink-0 text-disabled" />}
                      {t.name}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <TierBadge tier={t.tier} />
                </td>
                <td className="px-5 py-3 text-secondary">
                  {t.retentionYears ? `${t.retentionYears} Jahre` : 'keine feste Frist'}
                </td>
                <td className="px-5 py-3 text-muted">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-disabled" />
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
                        className="btn-secondary text-xs mr-2"
                      >
                        {t.active ? 'Deaktivieren' : 'Aktivieren'}
                      </button>
                      <button
                        type="button"
                        title="Umbenennen"
                        aria-label={`Datei-Typ „${t.name}“ umbenennen`}
                        onClick={() => {
                          setEditId(t.id);
                          setEditName(t.name);
                        }}
                        className="icon-action"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Löschen"
                        aria-label={`Datei-Typ „${t.name}“ löschen`}
                        onClick={() => remove(t)}
                        className="icon-action hover:!text-red-700"
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
        <div className="card min-w-0 space-y-4 p-4 sm:p-6">
          <h2 className="text-base font-semibold text-primary">Neuer Datei-Typ</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 [&>*]:min-w-0">
            <div>
              <label className="label" htmlFor="dt-name">
                Name
              </label>
              <input
                id="dt-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input min-w-0"
                maxLength={120}
                placeholder="z. B. Arbeitspapiere"
              />
            </div>
            <div>
              <label className="label" htmlFor="dt-retention">
                Aufbewahrung
              </label>
              <select
                id="dt-retention"
                value={newTier === 'GOBD' ? newRetentionYears : newTier === 'GWG' ? 5 : 0}
                onChange={(e) => setNewRetentionYears(Number(e.target.value) as 6 | 8 | 10)}
                className="input min-w-0"
                disabled={newTier !== 'GOBD'}
              >
                {newTier === 'NONE' && <option value={0}>keine feste Frist</option>}
                {newTier === 'GWG' && <option value={5}>5 Jahre Grundlock</option>}
                {newTier === 'GOBD' && (
                  <>
                    <option value={6}>6 Jahre</option>
                    <option value={8}>8 Jahre</option>
                    <option value={10}>10 Jahre</option>
                  </>
                )}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="dt-tier">
                Schutzstufe (danach fix)
              </label>
              <select
                id="dt-tier"
                value={newTier}
                onChange={(e) => setNewTier(e.target.value as Tier)}
                className="input min-w-0"
              >
                <option value="NONE">Kein Lock</option>
                <option value="GWG">GwG · 5 Jahre + fachliche Prüfung</option>
                <option value="GOBD">GoBD · 6/8/10 Jahre</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-muted">
            Schutzstufe und Frist lassen sich nach Anlage nicht mehr ändern (sonst müssten alle
            bereits abgelegten Dokumente dieses Typs umkopiert werden). Für eine andere Stufe einen
            neuen Typ anlegen.
          </p>
          <div className="flex flex-wrap gap-2">
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
        <button type="button" onClick={() => setCreating(true)} className="btn-primary">
          <Plus className="h-4 w-4" />
          Eigenen Typ anlegen
        </button>
      )}
    </div>
  );
}
