import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { deleteArticleAction } from '../actions';
import { renderMarkdown } from '@/lib/markdown';
import { fmtDateShort } from '@/lib/fmt';

export default async function KbArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const article = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const a = await tx.kbArticle.findUnique({
        where: { id },
        include: { category: { select: { name: true } } },
      });
      if (a) {
        await tx.kbArticle.update({
          where: { id },
          data: { viewCount: { increment: 1 } },
        });
      }
      return a;
    },
  );

  if (!article) notFound();

  const html = renderMarkdown(article.body);

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/knowledge" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{article.title}</h1>
            {!article.published && <span className="badge-gray">Entwurf</span>}
          </div>
          <p className="text-muted text-sm">
            {article.category?.name ?? 'Ohne Kategorie'}
            {' · '}
            Aktualisiert {fmtDateShort(article.updatedAt)}
            {' · '}
            {article.viewCount} Aufrufe
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/staff/knowledge/${article.id}/edit`}
            className="btn-secondary text-xs py-1.5"
          >
            <Pencil className="h-3.5 w-3.5" />
            Bearbeiten
          </Link>
          <form action={deleteArticleAction}>
            <input type="hidden" name="id" value={article.id} />
            <button
              type="submit"
              className="btn-secondary text-xs py-1.5 text-red-700 border-red-300 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Löschen
            </button>
          </form>
        </div>
      </div>

      <article
        className="card p-8 prose prose-sm max-w-none [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ul]:ml-6 [&_ol]:list-decimal [&_ol]:ml-6 [&_li]:my-1 [&_a]:text-brand-700 [&_a:hover]:underline [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_blockquote]:border-l-4 [&_blockquote]:border-strong [&_blockquote]:pl-4 [&_blockquote]:text-secondary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
