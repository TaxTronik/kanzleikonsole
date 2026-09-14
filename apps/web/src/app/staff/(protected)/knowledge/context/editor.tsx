'use client';
import { useState, useTransition } from 'react';
import { saveKnowledgeContextAction } from './actions';
export function ContextEditor({
  targets,
  articles,
}: {
  targets: Array<{ id: string; type: 'STEP' | 'TEMPLATE'; label: string; articleIds: string[] }>;
  articles: Array<{ id: string; title: string }>;
}) {
  const [key, setKey] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [savedSelections, setSavedSelections] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const target = targets.find((entry) => `${entry.type}:${entry.id}` === key);
  const ids = drafts[key] ?? savedSelections[key] ?? target?.articleIds ?? [];
  const savedIds = savedSelections[key] ?? target?.articleIds ?? [];
  const dirty = ids.length !== savedIds.length || ids.some((id) => !savedIds.includes(id));
  return (
    <form
      className="card p-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target || pending || ids.length > 10) return;
        setMessage('');
        start(async () => {
          try {
            const r = await saveKnowledgeContextAction({
              type: target.type,
              id: target.id,
              articleIds: ids,
            });
            if (r.ok) setSavedSelections((current) => ({ ...current, [key]: [...ids] }));
            setMessage(
              r.ok
                ? 'Verknüpfung gespeichert. Laufende Vorgänge bleiben unverändert.'
                : (r.error ?? 'Aktion fehlgeschlagen.'),
            );
          } catch {
            setMessage('Speichern fehlgeschlagen. Bitte erneut versuchen.');
          }
        });
      }}
    >
      <label className="block">
        Vorlagenschritt / Anforderungsvorlage
        <select
          className="input"
          required
          value={key}
          disabled={pending || targets.length === 0}
          onChange={(e) => {
            setKey(e.target.value);
            setMessage('');
          }}
        >
          <option value="">Bitte wählen</option>
          {targets.map((t) => (
            <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">
        {targets.length === 0
          ? 'Noch keine Vorlagenschritte oder Anforderungsvorlagen vorhanden.'
          : 'Entwürfe bleiben beim Wechsel der Vorlage in dieser Ansicht erhalten. Gespeichert wird nur die aktuelle Auswahl.'}
      </p>
      <fieldset disabled={pending || !target} aria-describedby="context-selection-limit">
        <legend>Veröffentlichte Artikel (höchstens 10)</legend>
        {articles.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            Noch keine veröffentlichten Kanzleiartikel vorhanden.
          </p>
        )}
        {articles.map((a) => (
          <label key={a.id} className="flex gap-2 py-1">
            <input
              type="checkbox"
              checked={ids.includes(a.id)}
              disabled={!ids.includes(a.id) && ids.length >= 10}
              onChange={(e) => {
                const next = e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id);
                setDrafts((current) => ({ ...current, [key]: next }));
                setMessage('');
              }}
            />
            {a.title}
          </label>
        ))}
      </fieldset>
      <div id="context-selection-limit" role="status" className="text-sm text-muted">
        <p>{ids.length} von höchstens 10 Artikeln ausgewählt.</p>
        {ids.length >= 10 && <p>Wählen Sie einen Artikel ab, um einen anderen hinzuzufügen.</p>}
      </div>
      <button disabled={pending || !target || ids.length > 10} className="btn-primary">
        {pending ? 'Speichert…' : 'Speichern'}
      </button>
      <p role="status">{message || (dirty ? 'Nicht gespeicherte Änderungen.' : '')}</p>
    </form>
  );
}
