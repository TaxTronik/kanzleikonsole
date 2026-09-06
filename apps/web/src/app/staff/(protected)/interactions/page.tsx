import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { ExpansionForm } from '@/components/expansion-form';
import {
  inviteNoticeDecisionAction,
  configureFeedbackAction,
  reviewInteractionAction,
} from './actions';
import { fmtDateTimeShort } from '@/lib/fmt';
import { feedbackMonthlyTrend, feedbackMonthWindow } from '@/server/workflows/dashboard-policy';

export default async function InteractionsPage() {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const modules = await readModules(ctx);
  const trendNow = new Date();
  const trendWindow = feedbackMonthWindow(trendNow);
  if (!modules.noticeDecisions && !modules.feedbackSurveys) redirect('/staff/dashboard');
  const data = await withTenantContext(ctx, async (tx) => {
    const clients = await tx.client.findMany({
      where: await accessibleClientsWhereFor(tx, session),
      select: { id: true, name: true },
    });
    const clientIds = clients.map((c) => c.id);
    const contacts = await tx.clientContact.findMany({
      where: { clientId: { in: clientIds }, active: true },
      select: { id: true, fullName: true, clientId: true },
      orderBy: { fullName: 'asc' },
    });
    const notices =
      modules.noticeDecisions && modules.taxNotices
        ? await tx.taxNotice.findMany({
            where: { clientId: { in: clientIds }, status: 'GEPRUEFT' },
            select: { id: true, kind: true, period: true, clientId: true },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })
        : [];
    const workflows =
      modules.feedbackSurveys && modules.workflows
        ? await tx.workflowInstance.findMany({
            where: {
              clientId: { in: clientIds },
              status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
            },
            select: { id: true, name: true, status: true, clientId: true, feedbackContactId: true },
            orderBy: { startedAt: 'desc' },
            take: 200,
          })
        : [];
    const rows = await tx.clientInteraction.findMany({
      where: {
        clientId: { in: clientIds },
        kind: {
          in: [
            ...(modules.noticeDecisions ? ['NOTICE'] : []),
            ...(modules.feedbackSurveys ? ['FEEDBACK'] : []),
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const trendRows = modules.feedbackSurveys
      ? await tx.clientInteraction.findMany({
          where: {
            clientId: { in: clientIds },
            kind: 'FEEDBACK',
            createdAt: { gte: trendWindow.start, lte: trendNow },
          },
          select: { kind: true, createdAt: true, respondedAt: true, response: true },
          orderBy: { createdAt: 'desc' },
          take: 5001,
        })
      : [];
    return { clients, contacts, notices, workflows, rows, trendRows };
  });
  const clientName = (id: string) => data.clients.find((c) => c.id === id)?.name ?? 'Mandant';
  const trend = feedbackMonthlyTrend(data.trendRows.slice(0, 5000), trendNow);
  const contactOptions = data.contacts.map((c) => (
    <option key={c.id} value={c.id}>
      {clientName(c.clientId)}: {c.fullName}
    </option>
  ));
  return (
    <div className="p-8 max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold">Mandantenentscheidungen und Feedback</h1>
      <p>
        Antwort, Kanzleiprüfung und fachliche Fristerledigung bleiben getrennt. Anfragen werden im
        Portal bereitgestellt; kein zusätzlicher E-Mail-Versand.
      </p>
      {modules.noticeDecisions && modules.taxNotices && (
        <details className="card p-5">
          <summary className="font-semibold">Bescheidentscheidung anfragen</summary>
          <ExpansionForm
            action={inviteNoticeDecisionAction}
            label="Persönliche Anfrage im Portal bereitstellen"
          >
            <label className="block">
              Geprüfter Bescheid
              <select className="input" required name="noticeId">
                <option value="">Bitte wählen</option>
                {data.notices.map((n) => (
                  <option key={n.id} value={n.id}>
                    {clientName(n.clientId)}: {n.kind} {n.period}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Antwortberechtigter Kontakt
              <select className="input" required name="contactId">
                <option value="">Bitte wählen</option>
                {contactOptions}
              </select>
            </label>
            <label className="block">
              Mandantensichtbare Abweichungsanalyse / Erläuterung
              <textarea
                className="input"
                name="explanation"
                required
                minLength={10}
                maxLength={5000}
              />
            </label>
            <label className="block">
              Antworttermin (Berlin, spätestens am Fristende)
              <input className="input" name="due" type="datetime-local" required />
            </label>
          </ExpansionForm>
        </details>
      )}
      {modules.feedbackSurveys && modules.workflows && (
        <details className="card p-5">
          <summary className="font-semibold">Feedback nach Workflow-Abschluss</summary>
          <p className="my-3">
            Aktive Workflows lösen die Anfrage bei ihrem Abschluss aus. Abgeschlossene Workflows
            werden sofort angefragt. Mindestens 90 Tage Abstand pro Mandant, eine Anfrage pro
            Workflow und keine automatischen Mahnungen.
          </p>
          <ExpansionForm action={configureFeedbackAction} label="Feedback einrichten / anfragen">
            <label className="block">
              Workflow
              <select required className="input" name="instanceId">
                <option value="">Bitte wählen</option>
                {data.workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {clientName(w.clientId)}: {w.name} ({w.status}
                    {w.feedbackContactId ? ', Feedback eingerichtet' : ''})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Kontakt
              <select className="input" required name="contactId">
                <option value="">Bitte wählen</option>
                {contactOptions}
              </select>
            </label>
          </ExpansionForm>
        </details>
      )}
      {modules.feedbackSurveys && (
        <section className="card p-4 space-y-3">
          <h2 className="text-lg font-semibold">Service-Barometer – Monatsverlauf</h2>
          <p>
            Einladungsmonate {trend[0]?.month} bis {trend.at(-1)?.month} (Europe/Berlin), Stand{' '}
            {fmtDateTimeShort(trendNow)}. Antworten werden dem Monat ihrer Einladung zugeordnet.
            Rücklauf = Antworten / Einladungen im gleichen sichtbaren Ausschnitt, einschließlich
            später zurückgezogener Einladungen. Junge Einladungen sind noch nicht ausgereift;
            Antwortfenster 30 Tage.
          </p>
          {data.trendRows.length > 5000 ? (
            <p className="text-amber-800">
              Begrenzter Ausschnitt: nur die letzten 5.000 zugänglichen Einladungen dieser zwölf
              Monate. Monatswerte und Nenner beziehen sich ausschließlich darauf.
            </p>
          ) : (
            <p>
              {data.trendRows.length} zugängliche Einladungen in diesen zwölf Monaten. Keine
              anonymen Bewertungen; keine repräsentative Zufriedenheitsmessung.
            </p>
          )}
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left p-2">Einladungsmonat</th>
                  <th className="text-right p-2">Ø Bewertung / 5</th>
                  <th className="text-right p-2">Antworten / Einladungen</th>
                  <th className="text-right p-2">Rücklauf</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((month) => (
                  <tr key={month.month} className="border-t">
                    <th className="text-left p-2 font-normal">{month.month}</th>
                    <td className="text-right p-2">
                      {month.average === null
                        ? '—'
                        : month.average.toLocaleString('de-DE', {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}
                    </td>
                    <td className="text-right p-2">
                      {month.responses} / {month.invitations}
                    </td>
                    <td className="text-right p-2">
                      {month.responseRate === null
                        ? '—'
                        : month.responseRate.toLocaleString('de-DE', { maximumFractionDigits: 1 }) +
                          ' %'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div className="space-y-3">
        {data.rows.map((r) => (
          <article key={r.id} className="card p-5">
            <div className="flex justify-between gap-3">
              <h2 className="font-semibold">
                {clientName(r.clientId)} ·{' '}
                {r.kind === 'NOTICE' ? 'Bescheidentscheidung' : 'Service-Feedback'}
              </h2>
              <span>
                {r.status === 'OPEN' && r.expiresAt < new Date()
                  ? 'Antwort überfällig / Zeitraum beendet'
                  : r.status === 'RESPONDED'
                    ? r.reviewedAt
                      ? 'Kanzleiprüfung dokumentiert'
                      : 'Antwort eingegangen – Prüfung offen'
                    : r.status === 'REVOKED'
                      ? 'Zurückgezogen'
                      : 'Antwort offen'}
              </span>
            </div>
            <p className="text-sm text-muted">
              {data.contacts.find((c) => c.id === r.contactId)?.fullName ?? 'Historischer Kontakt'}{' '}
              · angefragt {fmtDateTimeShort(r.createdAt)} · Antworttermin{' '}
              {fmtDateTimeShort(r.expiresAt)}
            </p>
            {r.response && (
              <p className="mt-2">
                Antwort:{' '}
                {r.response === 'APPEAL_REQUESTED'
                  ? 'Einspruch beauftragen'
                  : r.response === 'NO_OBJECTIONS'
                    ? 'Keine Einwände'
                    : `${r.response} von 5 Sternen`}
              </p>
            )}
            {r.message && <p className="whitespace-pre-wrap">{r.message}</p>}
            <Link className="underline text-sm" href={`/staff/requests/${r.requestId}`}>
              Zugehörige Anforderung
            </Link>
            {r.status === 'OPEN' ? (
              <ExpansionForm action={reviewInteractionAction} label="Anfrage zurückziehen">
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="revoke" value="1" />
              </ExpansionForm>
            ) : r.status === 'RESPONDED' && !r.reviewedAt ? (
              <ExpansionForm
                action={reviewInteractionAction}
                label="Rückmeldung geprüft (keine Fristerledigung)"
              >
                <input type="hidden" name="id" value={r.id} />
              </ExpansionForm>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
