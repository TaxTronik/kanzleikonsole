'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { loadKnowledgeContextAction } from '@/app/staff/(protected)/knowledge/context/actions';

export function KnowledgeContext({ type, id }: { type: 'ITEM' | 'REQUEST'; id: string }) {
  const [articles, setArticles] = useState<Array<{
    id: string;
    title: string;
    html: string;
    updatedAt: string;
  }> | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="my-2 text-sm">
      <button
        type="button"
        className="btn-secondary text-xs"
        disabled={pending}
        onClick={() => {
          if (articles) {
            setArticles(null);
            return;
          }
          start(async () => {
            const r = await loadKnowledgeContextAction({ type, id });
            if (!r.ok) setError(r.error ?? 'Aktion fehlgeschlagen.');
            else {
              setError('');
              setArticles(r.articles ?? []);
            }
          });
        }}
      >
        Kanzleileitfaden {articles ? 'schließen' : 'öffnen'}
      </button>
      {error && <p role="alert">{error}</p>}
      {articles && (
        <aside className="card p-4 mt-2 space-y-4" aria-label="Kanzleileitfaden">
          <p className="text-muted">
            Aktuelle Kanzleiartikel; kein historischer Lesebestätigungsnachweis.
          </p>
          {articles.length === 0 && <p>Keine veröffentlichten Artikel verknüpft.</p>}
          {articles.map((a) => (
            <section key={a.id}>
              <Link className="font-semibold underline" href={`/staff/knowledge/${a.id}`}>
                {a.title}
              </Link>
              <div className="prose prose-sm" dangerouslySetInnerHTML={{ __html: a.html }} />
            </section>
          ))}
        </aside>
      )}
    </div>
  );
}
