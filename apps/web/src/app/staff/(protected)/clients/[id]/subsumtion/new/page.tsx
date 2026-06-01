import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { guardSubsumtionPage } from '../_guard';
import { SubsumtionWorkspace } from '../subsumtion-workspace';

export default async function NewSubsumtionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { staffOptions, engineConfigured } = await guardSubsumtionPage(id);

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/staff/clients/${id}/subsumtion`} className="text-disabled hover:text-secondary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue Subsumtion</h1>
      </div>
      <SubsumtionWorkspace
        clientId={id}
        staffOptions={staffOptions}
        engineConfigured={engineConfigured}
        initial={null}
      />
    </div>
  );
}
