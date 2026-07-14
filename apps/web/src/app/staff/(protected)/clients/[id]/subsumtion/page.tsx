import Link from 'next/link';
import { ArrowLeft, Plus, FileSearch, Sparkles } from 'lucide-react';
import { guardSubsumtionPage } from './_guard';
import { listAnalyses } from '@/server/risk';
import { fmtDateTimeShort } from '@/lib/fmt';

export default async function SubsumtionListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, engineConfigured } = await guardSubsumtionPage(id);
  const analyses = await listAnalyses(ctx, id);

  return (
    <div className="p-8">
      <div className="flex items-start gap-4 mb-6">
        <Link href={`/staff/clients/${id}`} className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <FileSearch className="h-6 w-6 text-disabled" />
            Subsumtion / TCMS
          </h1>
          <p className="text-muted text-sm mt-1">
            Sachverhalte analysieren, Risiken markieren und bewerten, Recherche delegieren.
          </p>
        </div>
        <Link href={`/staff/clients/${id}/subsumtion/new`} className="btn-primary text-sm shrink-0">
          <Plus className="h-4 w-4" />
          Neue Subsumtion
        </Link>
      </div>

      {!engineConfigured && (
        <div className="alert-error-sm mb-4">
          Die Risk-Engine ist nicht konfiguriert. Sachverhalte lassen sich erfassen, aber noch nicht
          analysieren.
        </div>
      )}

      <div className="card overflow-hidden">
        {analyses.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Sparkles className="h-10 w-10 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Noch keine Subsumtion. Lege die erste an.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {analyses.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/staff/clients/${id}/subsumtion/${a.id}`}
                  className="block px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-primary truncate inline-flex items-center gap-2">
                        {a.title || 'Subsumtion'}
                        {a.llmEnrichedAt && (
                          <span className="badge-purple text-[10px]">KI-vertieft</span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted">
                        {fmtDateTimeShort(a.createdAt)} · Katalog {a.katalogVersion} · Engine{' '}
                        {a.engineVersion}
                      </p>
                    </div>
                    <span className="badge-gray text-xs shrink-0">
                      {a._count.markings} Markierungen
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
