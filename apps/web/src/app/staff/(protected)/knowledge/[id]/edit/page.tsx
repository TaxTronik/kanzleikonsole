import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { ArticleEditor } from '../../article-editor';
import { updateArticleAction } from '../../actions';

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const [article, categories] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.kbArticle.findUnique({ where: { id } }),
        tx.kbCategory.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      ]),
  );

  if (!article) notFound();

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href={`/staff/knowledge/${article.id}`}
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Bearbeiten</h1>
      </div>

      <ArticleEditor
        action={updateArticleAction}
        categories={categories}
        initial={{
          id: article.id,
          title: article.title,
          body: article.body,
          categoryId: article.categoryId ?? '',
          published: article.published,
        }}
      />
    </div>
  );
}
