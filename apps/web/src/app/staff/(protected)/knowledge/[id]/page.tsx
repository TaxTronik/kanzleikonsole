import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  CalendarDays,
  Download,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Pencil,
  Trash2,
  UserRound,
} from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { deleteArticleAction } from '../actions';
import { renderMarkdown } from '@/lib/markdown';
import { fmtDateShort } from '@/lib/fmt';

export default async function KbArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const article = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const a = await tx.kbArticle.findUnique({
        where: { id },
        include: {
          category: { select: { name: true } },
          attachments: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, displayName: true, mimeType: true },
          },
        },
      });
      if (a) {
        const author = await tx.staffUser.findFirst({
          where: { id: a.authorId },
          select: { fullName: true },
        });
        await tx.kbArticle.update({
          where: { id },
          data: { viewCount: { increment: 1 } },
        });
        return { ...a, authorName: author?.fullName ?? 'Unbekannter Verfasser' };
      }
      return null;
    },
  );

  if (!article) notFound();

  const html = renderMarkdown(article.body);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/knowledge" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{article.title}</h1>
            {!article.published && <span className="badge-gray">Entwurf</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>{article.category?.name ?? 'Ohne Kategorie'}</span>
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="h-4 w-4" />
              Verfasst von {article.authorName}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" />
              Erstellt am {fmtDateShort(article.createdAt)}
            </span>
            <span>Aktualisiert {fmtDateShort(article.updatedAt)}</span>
            <span>{article.viewCount} Aufrufe</span>
          </div>
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
        className="card prose max-w-none p-10 [&_a:hover]:underline [&_a]:text-brand-700 [&_blockquote]:border-l-4 [&_blockquote]:border-strong [&_blockquote]:pl-4 [&_blockquote]:text-secondary [&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_img]:my-8 [&_img]:max-h-[44rem] [&_img]:max-w-full [&_img]:rounded-xl [&_img]:border [&_img]:border-default [&_img]:object-contain [&_li]:my-1 [&_ol]:ml-6 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-gray-100 [&_pre]:p-3 [&_ul]:ml-6 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {article.attachments.length > 0 && (
        <section className="card mt-6 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold text-primary">
              Anhänge ({article.attachments.length})
            </h2>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {article.attachments.map((attachment) => {
              const isImage = attachment.mimeType.startsWith('image/');
              return (
                <li key={attachment.id}>
                  <a
                    href={`/api/staff/knowledge/attachments/${attachment.id}?download=1`}
                    className="flex items-center gap-3 rounded-lg border border-default px-4 py-3 text-sm text-secondary hover:bg-gray-50 hover:text-primary"
                  >
                    {isImage ? (
                      <ImageIcon className="h-5 w-5 shrink-0 text-blue-600" />
                    ) : (
                      <FileText className="h-5 w-5 shrink-0 text-violet-600" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{attachment.displayName}</span>
                    <Download className="h-4 w-4 shrink-0 text-muted" />
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
