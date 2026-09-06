import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { sourceIsFresh } from '@taxtronik/tax';
import { requireStaffPage } from '@/server/auth/staff-page';
import { latestScreeningContextTx } from '@/server/screening/gwg-gate';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertModuleEnabled } from '@/server/settings/modules';
import { ScreeningForms, ScreeningReviewForm } from './forms';
export default async function ScreeningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireStaffPage();
  const ctx: TenantContext = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF',
  };
  await assertModuleEnabled(ctx, 'sanctionsScreening');
  const data = await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, id);
    return {
      context: await latestScreeningContextTx(tx, ctx.tenantId, id),
      client: await tx.client.findUnique({ where: { id }, select: { name: true } }),
      state: await tx.sanctionsSourceState.findUnique({
        where: { tenantId: ctx.tenantId },
        include: {
          snapshot: {
            select: { sourceVersion: true, publishedAt: true, sha256: true, entryCount: true },
          },
        },
      }),
      runs: await tx.screeningRun.findMany({
        where: { tenantId: ctx.tenantId, clientId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          reviews: { orderBy: { createdAt: 'desc' } },
          snapshot: { select: { sourceVersion: true, publishedAt: true } },
        },
      }),
    };
  });
  if (!data.client) notFound();
  return (
    <main className="max-w-5xl p-8 space-y-6">
      <Link href={`/staff/clients/${id}`}>← {data.client.name}</Link>
      <h1 className="text-2xl font-bold">Sanktionsabgleich und PEP-Recherche</h1>
      <p className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-950">
        Ungeprüfter fachlicher Entwurf. Namensähnlichkeiten sind Prüfhinweise; kein Treffer ist
        keine Freigabe. Eigentums- und Kontrollverhältnisse sowie PEP-Eigenschaften werden nicht
        automatisch beurteilt. Bestehende GwG-Prüfungen und Mandatsfreigaben bleiben unverändert.
      </p>
      <p>
        EU-Quelle:{' '}
        {data.state?.snapshot
          ? `${data.state.snapshot.entryCount} Einträge · Veröffentlichung ${data.state.snapshot.publishedAt.toLocaleDateString('de-DE')} · erfolgreicher Abruf ${data.state.checkedAt?.toLocaleString('de-DE') ?? 'unbekannt'}`
          : 'noch nicht importiert'}{' '}
        ·{' '}
        {sourceIsFresh(data.state?.checkedAt ?? null, data.state?.lastError ?? null)
          ? 'Abruf aktuell'
          : 'nicht aktuell / Fehler – erneuter Abgleich gesperrt'}
        . <Link href="/staff/admin/screening">Quellenverwaltung</Link>
      </p>
      <ScreeningForms clientId={id} defaultName={data.client.name} context={data.context} />
      <h2 className="text-lg font-semibold">Letzte 50 unveränderliche Prüfläufe</h2>
      {data.runs.map((run) => (
        <article key={run.id} className="rounded-lg border border-default p-4 space-y-2">
          <h3 className="font-semibold">
            {run.kind === 'PEP' ? 'Manuelle PEP-Recherche' : 'EU-Namensabgleich'} ·{' '}
            {run.createdAt.toLocaleString('de-DE')}
            {run.previousRunId ? ' · automatischer Folgelauf' : ''}
          </h3>
          <p className="text-sm">
            Bearbeiter: {run.createdBy ?? 'System'} · Quellversion:{' '}
            {run.snapshot?.sourceVersion ?? 'manuelle Quellen'}
          </p>
          <pre className="overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-3 text-xs">
            {JSON.stringify({ person: run.subject, ergebnis: run.result }, null, 2)}
          </pre>
          {run.reviews.map((review) => (
            <div key={review.id} className="border-l-2 pl-3 text-sm">
              <strong>{review.outcome}</strong> · {review.createdAt.toLocaleString('de-DE')} ·{' '}
              {review.createdBy}
              <p className="whitespace-pre-wrap">{review.note}</p>
              <ul>
                {(review.sources as string[]).map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ScreeningReviewForm clientId={id} runId={run.id} pep={run.kind === 'PEP'} />
        </article>
      ))}
    </main>
  );
}
