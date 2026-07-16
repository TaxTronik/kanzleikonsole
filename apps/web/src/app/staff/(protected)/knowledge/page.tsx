import Link from 'next/link';
import { BookOpen, Plus } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { searchArticles, type SearchHit } from './actions';
import { fmtDateShort } from '@/lib/fmt';

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string }>;
}) {
  const session = await requireStaffPage();

  const sp = await searchParams;
  const query = sp.q?.trim() ?? '';
  const catFilter = sp.cat;
  const { tenantId, staffId } = session.user;

  let searchHits: SearchHit[] | null = null;
  if (query) {
    searchHits = await searchArticles(query);
  }

  const [categories, articles] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.kbCategory.findMany({
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { articles: true } } },
        }),
        tx.kbArticle.findMany({
          where: catFilter ? { categoryId: catFilter, published: true } : { published: true },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          include: { category: { select: { name: true } } },
        }),
      ]),
  );

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Wissensdatenbank</h1>
          <p className="text-muted text-sm">
            Interne Anleitungen, Vorlagen und Verfahrensbeschreibungen.
          </p>
        </div>
        <Link href="/staff/knowledge/new" className="btn-primary">
          <Plus className="h-3.5 w-3.5" />
          Neuer Artikel
        </Link>
      </div>

      {/* Suchbar */}
      <form className="mb-6" action="/staff/knowledge" method="get">
        <input
          type="search"
          name="q"
          className="input"
          placeholder="Volltextsuche (deutsch, mit Stemming)…"
          defaultValue={query}
        />
      </form>

      {searchHits ? (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-default">
            <h2 className="text-sm font-medium text-primary">
              {searchHits.length} Treffer für „{query}"
            </h2>
          </div>
          {searchHits.length === 0 ? (
            <p className="px-6 py-10 text-sm text-disabled text-center">Nichts gefunden.</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {searchHits.map((h) => (
                <li key={h.id} className="px-6 py-4">
                  <Link
                    href={`/staff/knowledge/${h.id}`}
                    className="block hover:bg-gray-50 -mx-6 px-6"
                  >
                    <p className="font-medium text-primary">{h.title}</p>
                    {h.categoryName && <p className="text-xs text-muted mb-2">{h.categoryName}</p>}
                    <p
                      className="text-sm text-secondary [&_mark]:bg-yellow-200 [&_mark]:px-0.5"
                      dangerouslySetInnerHTML={{ __html: h.snippet }}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Kategorien */}
          <aside className="card p-4 h-fit">
            <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Kategorien
            </h2>
            <ul className="space-y-1">
              <li>
                <Link
                  href="/staff/knowledge"
                  className={
                    !catFilter
                      ? 'block px-3 py-2 text-sm rounded-md bg-brand-50 text-brand-700 font-medium'
                      : 'block px-3 py-2 text-sm rounded-md hover:bg-gray-100 text-secondary'
                  }
                >
                  Alle Artikel
                </Link>
              </li>
              {categories.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/staff/knowledge?cat=${c.id}`}
                    className={
                      catFilter === c.id
                        ? 'flex items-center justify-between px-3 py-2 text-sm rounded-md bg-brand-50 text-brand-700 font-medium'
                        : 'flex items-center justify-between px-3 py-2 text-sm rounded-md hover:bg-gray-100 text-secondary'
                    }
                  >
                    <span>{c.name}</span>
                    <span className="text-xs text-disabled">{c._count.articles}</span>
                  </Link>
                </li>
              ))}
              {categories.length === 0 && (
                <li className="text-sm text-disabled px-3 py-2">Noch keine Kategorien</li>
              )}
            </ul>
            <Link
              href="/staff/knowledge/categories/new"
              className="mt-4 inline-block text-xs text-brand-700 hover:underline"
            >
              + Kategorie anlegen
            </Link>
          </aside>

          {/* Artikel-Liste */}
          <div className="lg:col-span-3 card overflow-hidden">
            {articles.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <BookOpen className="h-12 w-12 text-disabled mx-auto mb-3" />
                <p className="text-sm text-disabled">Noch keine Artikel.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {articles.map((a) => (
                  <li key={a.id} className="px-6 py-4 hover:bg-gray-50">
                    <Link href={`/staff/knowledge/${a.id}`} className="block">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-medium text-primary">{a.title}</p>
                        {!a.published && <span className="badge-gray">Entwurf</span>}
                      </div>
                      <p className="text-xs text-muted">
                        {a.category?.name ?? 'Ohne Kategorie'}
                        {' · '}
                        Aktualisiert {fmtDateShort(a.updatedAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
