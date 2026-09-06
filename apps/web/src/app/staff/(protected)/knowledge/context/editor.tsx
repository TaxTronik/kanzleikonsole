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
  const [ids, setIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  return (
    <form
      className="card p-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const target = targets.find((t) => `${t.type}:${t.id}` === key);
        if (!target) return;
        start(async () => {
          const r = await saveKnowledgeContextAction({
            type: target.type,
            id: target.id,
            articleIds: ids,
          });
          setMessage(
            r.ok
              ? 'Verknüpfung gespeichert. Laufende Vorgänge bleiben unverändert.'
              : (r.error ?? 'Aktion fehlgeschlagen.'),
          );
        });
      }}
    >
      <label className="block">
        Vorlagenschritt / Anforderungsvorlage
        <select
          className="input"
          required
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setIds(targets.find((t) => `${t.type}:${t.id}` === e.target.value)?.articleIds ?? []);
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
      <fieldset>
        <legend>Veröffentlichte Artikel (höchstens 10)</legend>
        {articles.map((a) => (
          <label key={a.id} className="flex gap-2 py-1">
            <input
              type="checkbox"
              checked={ids.includes(a.id)}
              onChange={(e) =>
                setIds((current) =>
                  e.target.checked ? [...current, a.id] : current.filter((id) => id !== a.id),
                )
              }
            />
            {a.title}
          </label>
        ))}
      </fieldset>
      <button disabled={pending || !key || ids.length > 10} className="btn-primary">
        Speichern
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
