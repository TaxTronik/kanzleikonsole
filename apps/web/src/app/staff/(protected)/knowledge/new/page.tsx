import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { randomUUID } from 'node:crypto';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { ArticleEditor } from '../article-editor';
import { createArticleAction } from '../actions';

export default async function NewArticlePage() {
  const session = await requireStaffPage();

  const { tenantId, staffId } = session.user;
  const categories = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.kbCategory.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  );

  return (
    <div className="mx-auto max-w-[1600px] p-8">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href="/staff/knowledge"
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neuer Artikel</h1>
      </div>

      <ArticleEditor
        action={createArticleAction}
        categories={categories}
        draftToken={randomUUID()}
      />
    </div>
  );
}
