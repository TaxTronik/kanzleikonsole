import Link from 'next/link';
import { withTenantContext } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { readModules } from '@/server/settings/modules';
import { loadStructureTx } from './service';
import { loadGwgStructureHistoryTx } from './gwg-structure';
import { ActionForm } from '@/app/staff/(protected)/mandate-expansion/action-form';
import { bindGwgStructureAction } from '@/app/staff/(protected)/mandate-expansion/structure/gwg-actions';

export async function GwgStructurePanel({
  session,
  clientId,
}: {
  session: StaffSession;
  clientId: string;
}) {
  const ctx = {
    tenantId: session.user.tenantId,
    actorType: 'STAFF' as const,
    actorId: session.user.staffId,
  };
  if (!(await readModules(ctx)).mandateStructure) return null;
  const data = await withTenantContext(ctx, async (tx) => {
    const history = await loadGwgStructureHistoryTx(tx, session, clientId);
    const check = await tx.gwgCheck.findFirst({
      where: { tenantId: ctx.tenantId, clientId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    let current: Awaited<ReturnType<typeof loadStructureTx>> = null;
    try {
      current = await loadStructureTx(tx, session, clientId);
    } catch {
      /* No partial structure data. */
    }
    return { history, check, current };
  });
  const open =
    data.check && !data.check.destroyedAt && ['DRAFT', 'IN_REVIEW'].includes(data.check.status);
  const latest = data.history.find((row) => row.binding.gwgCheckId === data.check?.id);
  return (
    <section className="card p-5 mb-6 space-y-4">
      <h2 className="font-semibold text-lg">Gebundene Beteiligungsstruktur in der GwG-Prüfung</h2>
      <p className="text-sm">
        Eine ausdrücklich gewählte unveränderliche Strukturversion dient als zusätzliche
        Arbeitsgrundlage. Sie ersetzt keine Ermittlung wirtschaftlich Berechtigter, Registerbelege
        oder fachliche Freigabe. Personen werden nicht automatisch in den GwG-Snapshot übernommen
        und mittelbare Quoten nicht berechnet.
      </p>
      <Link className="underline" href={`/staff/mandate-expansion/structure?clientId=${clientId}`}>
        Grafik und Tabellenstruktur bearbeiten
      </Link>
      {open && data.current ? (
        <ActionForm
          key={`${data.check!.id}:${latest?.binding.revision ?? 0}:${data.current.id}`}
          action={bindGwgStructureAction}
          className="border rounded p-4 space-y-3"
        >
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="checkId" value={data.check!.id} />
          <input type="hidden" name="versionId" value={data.current.id} />
          <input
            type="hidden"
            name="expectedBindingRevision"
            value={latest?.binding.revision ?? 0}
          />
          <p>
            Strukturversion {data.current.revision} ausdrücklich in die offene Prüfung vom{' '}
            {data.check!.createdAt.toISOString().slice(0, 10)} übernehmen.
          </p>
          <p className="text-xs break-all">Struktur SHA-256: {data.current.contentHash}</p>
          <label className="label">
            Herkunft, Bedeutung und noch offene fachliche Prüfung
            <textarea className="input" name="note" minLength={10} maxLength={3000} required />
          </label>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" name="confirmed" required />
            Ich bestätige diese konkrete Strukturversion als Arbeitsgrundlage. Eine laufende
            Einreichung wird auf Entwurf zurückgesetzt und muss erneut vorgelegt werden.
          </label>
          <button className="btn-secondary">Version für diese GwG-Prüfung binden</button>
        </ActionForm>
      ) : (
        <p className="text-sm">
          {!data.current
            ? 'Zuerst eine zugängliche Strukturversion speichern.'
            : 'Die neueste GwG-Prüfung ist nicht offen. Für neue Angaben einen neuen Prüfzyklus beginnen; frühere Prüfungen bleiben unverändert.'}
        </p>
      )}
      <h3 className="font-semibold">Zugängliche Übernahmehistorie</h3>
      {data.history.length === 0 && (
        <p className="text-sm">Keine zugängliche gebundene Strukturversion vorhanden.</p>
      )}
      {data.history.map(({ binding, version }, index) => {
        const nodes = new Map(version.input.nodes.map((n) => [n.key, n]));
        return (
          <details key={binding.id} open={index === 0} className="border rounded p-3">
            <summary>
              Prüfung {binding.check.createdAt.toISOString().slice(0, 10)} ({binding.check.status})
              · Übernahme {binding.revision} · Strukturversion {version.revision}
            </summary>
            <p className="my-2 whitespace-pre-wrap">{binding.note}</p>
            <p className="text-xs break-all">
              Gebunden {binding.createdAt.toISOString()} · Mitarbeiter-ID {binding.createdBy} ·
              SHA-256 {binding.structureHash}
            </p>
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm">
                <caption className="text-left font-medium">
                  Vollständige Knoten dieses gebundenen Stands
                </caption>
                <thead>
                  <tr>
                    <th className="text-left">Nr.</th>
                    <th className="text-left">Name</th>
                    <th className="text-left">Art</th>
                  </tr>
                </thead>
                <tbody>
                  {version.input.nodes.map((n, i) => (
                    <tr key={n.key}>
                      <td>#{String(i + 1).padStart(2, '0')}</td>
                      <td>{n.label}</td>
                      <td>{n.kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left font-medium">Direkte Verbindungen</caption>
                <thead>
                  <tr>
                    <th className="text-left">Von</th>
                    <th className="text-left">Zu</th>
                    <th className="text-left">Art / Quote</th>
                    <th className="text-left">Vermerk</th>
                  </tr>
                </thead>
                <tbody>
                  {version.input.edges.map((e, i) => (
                    <tr key={i}>
                      <td>{nodes.get(e.from)?.label}</td>
                      <td>{nodes.get(e.to)?.label}</td>
                      <td>
                        {e.kind} · {e.percentage === null ? 'keine Quote' : `${e.percentage} %`}
                      </td>
                      <td>{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </section>
  );
}
