import { redirect } from 'next/navigation';
import Link from 'next/link';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { ExpansionForm } from '@/components/expansion-form';
import { respondInteractionAction } from './actions';
import { noticeDecisionSnapshot } from '@/server/workflows/interactions';
import { fmtDateTimeShort, fmtDateShort } from '@/lib/fmt';
export default async function PortalInteractionsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const modules = await readModules(ctx);
  if (!modules.noticeDecisions && !modules.feedbackSurveys) redirect('/portal');
  const rows = await withTenantContext(ctx, (tx) =>
    tx.clientInteraction.findMany({
      where: {
        clientId,
        contactId,
        kind: {
          in: [
            ...(modules.noticeDecisions && modules.taxNotices ? ['NOTICE'] : []),
            ...(modules.feedbackSurveys ? ['FEEDBACK'] : []),
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  );
  return (
    <div className="p-8 max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold">Rückmeldungen an Ihre Kanzlei</h1>
      {!rows.length && <p>Keine persönlichen Anfragen vorhanden.</p>}
      {rows.map((row) => {
        const snapshot = row.kind === 'NOTICE' ? noticeDecisionSnapshot.parse(row.snapshot) : null;
        const open = row.status === 'OPEN' && row.expiresAt > new Date();
        return (
          <section key={row.id} className="card p-5 space-y-3">
            <h2 className="text-lg font-semibold">
              {snapshot?.title ?? 'Wie zufrieden sind Sie mit unserer Zusammenarbeit?'}
            </h2>
            <p className="text-sm text-muted">
              Antwort möglich bis {fmtDateTimeShort(row.expiresAt)}
            </p>
            {snapshot ? (
              <>
                <p className="whitespace-pre-wrap">{snapshot.explanation}</p>
                <p>
                  Dokumentierter Fristvorschlag: {fmtDateShort(new Date(snapshot.appealDeadline))}
                </p>
                <Link className="underline" href={`/api/portal/interactions/${row.id}/document`}>
                  Bescheid in der angefragten Fassung öffnen
                </Link>
                <p className="text-sm">
                  Ihre Rückmeldung wird von der Kanzlei geprüft. Sie legt keinen Einspruch ein und
                  beendet keine Fristenkontrolle.
                </p>
              </>
            ) : (
              <p>
                Freiwillige Rückmeldung. Ihre Kanzlei kann die Bewertung Ihrem Mandat zuordnen. Es
                werden keine automatischen Erinnerungen versandt.
              </p>
            )}
            {open ? (
              <ExpansionForm
                action={respondInteractionAction}
                label="Antwort verbindlich übermitteln"
              >
                <input type="hidden" name="id" value={row.id} />
                <fieldset>
                  <legend className="font-medium">Ihre Antwort</legend>
                  {row.kind === 'NOTICE' ? (
                    <>
                      <label className="flex gap-2">
                        <input required type="radio" name="response" value="APPEAL_REQUESTED" />
                        Einspruch beauftragen
                      </label>
                      <label className="flex gap-2">
                        <input required type="radio" name="response" value="NO_OBJECTIONS" />
                        Keine Einwände gegen den vorgelegten Bescheid
                      </label>
                    </>
                  ) : (
                    <div className="flex gap-4">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <label key={n}>
                          <input required type="radio" name="response" value={n} /> {n} Stern
                          {n === 1 ? '' : 'e'}
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <label className="block">
                  Nachricht (optional)
                  <textarea className="input" name="message" maxLength={3000} />
                </label>
              </ExpansionForm>
            ) : (
              <div>
                <p>
                  {row.status === 'RESPONDED'
                    ? `Antwort gespeichert: ${row.response === 'APPEAL_REQUESTED' ? 'Einspruch beauftragt' : row.response === 'NO_OBJECTIONS' ? 'Keine Einwände' : `${row.response} von 5 Sternen`}`
                    : row.status === 'REVOKED'
                      ? 'Von der Kanzlei zurückgezogen.'
                      : 'Antwortzeitraum beendet. Bitte wenden Sie sich direkt an die Kanzlei.'}
                </p>
                {row.message && <p className="whitespace-pre-wrap">{row.message}</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
