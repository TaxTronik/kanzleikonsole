'use client';

import { useState } from 'react';

interface Props {
  action: (formData: FormData) => Promise<void>;
  categories: Array<{ id: string; name: string }>;
  initial?: {
    id: string;
    title: string;
    body: string;
    categoryId: string;
    published: boolean;
  };
}

export function ArticleEditor({ action, categories, initial }: Props) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [showPreview, setShowPreview] = useState(false);

  return (
    <form action={action} className="card p-6 space-y-4">
      {initial && <input type="hidden" name="id" value={initial.id} />}

      <div>
        <label className="label" htmlFor="title">Titel</label>
        <input
          id="title"
          name="title"
          type="text"
          className="input"
          required
          minLength={1}
          maxLength={300}
          defaultValue={initial?.title ?? ''}
        />
      </div>

      <div>
        <label className="label" htmlFor="categoryId">Kategorie</label>
        <select
          id="categoryId"
          name="categoryId"
          className="input"
          defaultValue={initial?.categoryId ?? ''}
        >
          <option value="">— Ohne Kategorie —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="label" htmlFor="body">Inhalt (Markdown)</label>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="text-xs text-brand-700 hover:underline"
          >
            {showPreview ? 'Bearbeiten' : 'Vorschau'}
          </button>
        </div>
        {showPreview ? (
          <div className="input min-h-[400px] bg-gray-50 whitespace-pre-wrap font-mono text-sm">
            {body || <span className="text-gray-400">Vorschau (Roh-Markdown)…</span>}
          </div>
        ) : (
          <textarea
            id="body"
            name="body"
            rows={20}
            className="input font-mono text-sm"
            required
            minLength={1}
            maxLength={100000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="# Überschrift&#10;&#10;Markdown wird unterstützt: **fett**, *kursiv*, `code`, Listen, [Links](https://…)"
          />
        )}
        {!showPreview && (
          // Hidden field für FormData wenn Preview offen ist (nicht nötig hier weil textarea aktiv)
          <input type="hidden" name="body_hidden_unused" value={body} />
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="published"
          value="1"
          defaultChecked={initial?.published ?? true}
        />
        Veröffentlicht (für alle Mitarbeiter sichtbar)
      </label>

      <button type="submit" className="btn-primary">
        {initial ? 'Speichern' : 'Anlegen'}
      </button>
    </form>
  );
}
