import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { guardSubsumtionPage } from '../_guard';
import { listExtractableDocuments } from '@/server/risk';
import { SubsumtionWorkspace } from '../subsumtion-workspace';

export default async function NewSubsumtionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, staffOptions, engineConfigured } = await guardSubsumtionPage(id);
  const docs = await listExtractableDocuments(ctx, id);
  const clientDocuments = docs.map((d) => ({
    id: d.id,
    title: d.title,
    mimeType: d.mimeType,
    typeName: d.documentType?.name ?? '',
  }));

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/staff/clients/${id}/subsumtion`}
          className="text-disabled hover:text-secondary"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue Subsumtion</h1>
      </div>
      <SubsumtionWorkspace
        clientId={id}
        staffOptions={staffOptions}
        clientDocuments={clientDocuments}
        engineConfigured={engineConfigured}
        initial={null}
      />
    </div>
  );
}
