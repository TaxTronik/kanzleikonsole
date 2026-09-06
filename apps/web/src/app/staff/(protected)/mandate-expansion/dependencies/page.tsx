import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { loadDependenciesTx } from '@/server/mandate-expansion/service';
import { dependencyReady } from '@/server/mandate-expansion/model';
import { expansionPage, ExpansionNavigation } from '../common';
import { ActionForm } from '../action-form';
import { assignWorkflowYearAction, changeDependencyAction } from '../actions';

export default async function DependenciesPage() {
  await requireStaffPage();
  const { session, ctx } = await expansionPage('workflowDependencies');
  const data = await withTenantContext(ctx, (tx) => loadDependenciesTx(tx, session));
  const names = new Map(data.clients.map((c) => [c.id, c.name]));
  const label = (id: string) => {
    const item = data.items.find((item) => item.id === id);
    return item
      ? `${names.get(item.instance.clientId)} · ${item.instance.name} · ${item.instance.assessmentYear ?? 'Jahr unbestätigt'} · ${item.title}`
      : 'Nicht verfügbar';
  };
  const workflows = [
    ...new Map(data.items.map((item) => [item.instanceId, item.instance])).entries(),
  ];
  const targets = [
    ...new Set([...data.dependencies.map((d) => d.successorItemId), ...data.blockedTargets]),
  ];
  return (
    <main className="p-6 space-y-6">
      <ExpansionNavigation />
      <h1 className="text-2xl font-semibold">Mandatsübergreifende Workflow-Abhängigkeiten</h1>
      <p>
        Verbindungen gelten nur zwischen ausdrücklich bestätigten Vorgängen desselben
        Veranlagungsjahres. Alle Vorleistungen müssen erledigt sein. Fristen und fachliche
        Erledigungen werden nicht automatisch verändert.
      </p>
      <details className="card border rounded-lg p-5">
        <summary className="font-semibold cursor-pointer">Veranlagungsjahre bestätigen</summary>
        <p className="my-3">
          Ein Jahr wird niemals aus dem Namen oder Startdatum abgeleitet. Vor einer späteren
          Änderung müssen bestehende Verbindungen bewusst entfernt werden.
        </p>
        {workflows.map(([id, workflow]) => (
          <ActionForm
            action={assignWorkflowYearAction}
            key={id}
            className="flex flex-wrap gap-3 items-end border-t py-3"
          >
            <input type="hidden" name="instanceId" value={id} />
            <input type="hidden" name="expectedYear" value={workflow.assessmentYear ?? ''} />
            <label className="label grow">
              {names.get(workflow.clientId)} · {workflow.name}
              <input
                className="input"
                name="year"
                type="number"
                min="1900"
                max="2200"
                required
                defaultValue={workflow.assessmentYear ?? ''}
              />
            </label>
            <button className="btn-secondary">Jahr bestätigen</button>
          </ActionForm>
        ))}
      </details>
      <ActionForm action={changeDependencyAction} className="card border rounded-lg p-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="label">
            Vorleistung
            <select className="input" name="from" required>
              <option value="">Schritt wählen</option>
              {data.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Abhängiger Schritt
            <select className="input" name="to" required>
              <option value="">Schritt wählen</option>
              {data.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn-primary">Abhängigkeit hinzufügen</button>
      </ActionForm>
      <h2 className="font-semibold">Bereitschaft – aktueller Stand beim Laden</h2>
      {targets.length === 0 ? (
        <p>Es sind noch keine Abhängigkeiten angelegt.</p>
      ) : (
        targets.map((id) => {
          const dependencies = data.dependencies.filter((d) => d.successorItemId === id);
          const hidden = data.blockedTargets.has(id);
          const target = data.items.find((item) => item.id === id)!;
          const sameYear =
            target.instance.assessmentYear !== null &&
            dependencies.every(
              (d) => d.predecessor.instance.assessmentYear === target.instance.assessmentYear,
            );
          const ready =
            !hidden &&
            sameYear &&
            dependencyReady(
              dependencies.map((d) => ({
                doneAt: d.predecessor.doneAt,
                instanceStatus: d.predecessor.instance.status,
              })),
            );
          return (
            <section className="card border rounded-lg p-5 space-y-3" key={id}>
              <h3 className="font-semibold">{label(id)}</h3>
              <p className={ready ? 'text-green-700' : 'text-amber-800'}>
                {hidden
                  ? 'Bereitschaft nicht feststellbar: nicht alle Voraussetzungen sind verfügbar.'
                  : !sameYear
                    ? 'Bereitschaft nicht feststellbar: Veranlagungsjahre prüfen.'
                    : ready
                      ? 'Bereit zur Fertigstellung'
                      : 'Wartet auf Vorleistungen'}
              </p>
              <a
                className="text-blue-700 underline"
                href={`/staff/clients/${target.instance.clientId}/workflows`}
              >
                Workflow öffnen
              </a>
              {dependencies.map((d) => (
                <div className="border-t pt-3" key={d.id}>
                  <p>
                    {label(d.predecessorItemId)} · {d.predecessor.doneAt ? 'erledigt' : 'offen'}
                  </p>
                  <ActionForm action={changeDependencyAction}>
                    <input type="hidden" name="from" value={d.predecessorItemId} />
                    <input type="hidden" name="to" value={id} />
                    <input type="hidden" name="remove" value="true" />
                    <button className="text-sm underline">Verbindung entfernen</button>
                  </ActionForm>
                </div>
              ))}
            </section>
          );
        })
      )}
    </main>
  );
}
