import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { isUuid } from '@/lib/uuid';
import { visibleMandatesTx } from '@/server/mandate-expansion/service';
import { VDB_STATES, VDB_LABELS, vdbTransitionAllowed } from '@/server/mandate-expansion/model';
import { expansionPage, ExpansionNavigation, ClientSelect } from '../common';
import { ActionForm } from '../action-form';
import { recordVdbStateAction } from '../actions';
export default async function VdbPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  await requireStaffPage();
  const { session, ctx } = await expansionPage('vdbPreparation');
  const sp = await searchParams;
  const clientId = isUuid(sp.clientId ?? '') ? sp.clientId! : '';
  const clients = await withTenantContext(ctx, (tx) => visibleMandatesTx(tx, session));
  const data = clients.some((c) => c.id === clientId)
    ? await withTenantContext(ctx, async (tx) => ({
        poas: await tx.powerOfAttorney.findMany({
          where: { tenantId: session.user.tenantId, clientId },
          include: { vdbRecords: { orderBy: { revision: 'desc' } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        evidence: await tx.documentVersion.findMany({
          where: {
            scanStatus: 'CLEAN',
            scanCompletedAt: { not: null },
            document: {
              tenantId: session.user.tenantId,
              clientId,
              deletedAt: null,
              classification: { notIn: ['GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE'] },
              gwgDestroyedAt: null,
              gwgDestructionRequestedAt: null,
            },
          },
          include: { document: { select: { title: true } } },
          orderBy: { createdAt: 'desc' },
          take: 300,
        }),
      }))
    : null;
  return (
    <main className="p-6 space-y-6">
      <ExpansionNavigation />
      <h1 className="text-2xl font-semibold">VDB-Vorbereitung und externe Nachweise</h1>
      <aside className="border border-amber-300 bg-amber-50 p-5 rounded-lg">
        <h2 className="font-semibold">Dateiexport / direkte Meldung nicht freigeschaltet</h2>
        <p>
          Es liegt hier keine implementierte und nachgewiesene offizielle Importspezifikation vor.
          Deshalb werden keine vermeintlich VDB-kompatiblen XML-/CSV-Dateien erzeugt und keine
          Meldungen versandt. Die folgenden Angaben dokumentieren ausschließlich manuell belegte
          Vorgänge außerhalb dieser Anwendung.
        </p>
        <button className="btn-secondary mt-3" disabled>
          VDB-Importexport nicht verfügbar
        </button>
      </aside>
      <ClientSelect clients={clients} selected={clientId} />
      {data?.poas.length === 0 && <p>Für diesen Mandanten sind noch keine Vollmachten erfasst.</p>}
      {data?.poas.map((p) => {
        const latest = p.vdbRecords[0];
        const next = VDB_STATES.filter((s) => vdbTransitionAllowed(latest?.status ?? null, s));
        return (
          <section className="border rounded-lg p-5 space-y-4" key={p.id}>
            <h2 className="font-semibold">{p.subject}</h2>
            <p>
              Technischer Vollmachtsstatus: {p.status} · Externer Nachweis:{' '}
              {latest ? VDB_LABELS[latest.status] : 'Noch nicht vorbereitet'}
            </p>
            <p className="text-sm">
              Eine technische Signatur oder ein manueller Meldevermerk bestätigt weder
              Rechtswirksamkeit noch Abrufberechtigung. Dokumenttyp, Umfang und Form sind fachlich
              zu prüfen.
            </p>
            <ActionForm key={`${p.id}:${latest?.revision ?? 0}`} action={recordVdbStateAction}>
              <input type="hidden" name="poaId" value={p.id} />
              <input type="hidden" name="expectedRevision" value={latest?.revision ?? 0} />
              <div className="grid md:grid-cols-2 gap-3">
                <label className="label">
                  Nächster Nachweisstatus
                  <select className="input" name="status">
                    {next.map((s) => (
                      <option key={s} value={s}>
                        {VDB_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Datum des externen Vorgangs
                  <input
                    className="input"
                    type="date"
                    name="recordedAt"
                    defaultValue={new Date().toISOString().slice(0, 10)}
                    max={new Date().toISOString().slice(0, 10)}
                    required
                  />
                </label>
                <label className="label">
                  Externe Referenz
                  <input className="input" name="externalReference" maxLength={300} />
                </label>
                <label className="label">
                  Dokumentfassung als Nachweis
                  <select className="input" name="evidenceVersionId">
                    <option value="">Bei Vorbereitung optional</option>
                    {data.evidence.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.document.title} · Version {e.versionNo}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="label">
                Prüfung / Herkunft / Aussage des Nachweises
                <textarea className="input" name="note" minLength={10} maxLength={3000} required />
              </label>
              <button className="btn-primary">Nachweis unveränderlich protokollieren</button>
            </ActionForm>
            <details>
              <summary>Nachweisverlauf ({p.vdbRecords.length})</summary>
              <ol className="list-decimal pl-5">
                {p.vdbRecords.map((r) => (
                  <li key={r.id}>
                    {r.recordedAt.toISOString().slice(0, 10)} · {VDB_LABELS[r.status]} ·{' '}
                    {r.externalReference} · {r.note}
                  </li>
                ))}
              </ol>
            </details>
          </section>
        );
      })}
    </main>
  );
}
