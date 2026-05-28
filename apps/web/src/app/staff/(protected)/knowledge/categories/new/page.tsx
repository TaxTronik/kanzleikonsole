import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { CategoryForm } from './form';

export default async function NewCategoryPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;
  const categories = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.kbCategory.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  );

  return (
    <div className="p-8 max-w-md">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/knowledge" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue Kategorie</h1>
      </div>

      <div className="card p-6">
        <CategoryForm categories={categories} />
      </div>
    </div>
  );
}
