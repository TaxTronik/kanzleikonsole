import { withTenantContext } from '@taxtronik/db';
import { payrollGuard } from '@/server/payroll/service';
import { PAYROLL_SCHEMA, DATEV_GATE_MESSAGE } from '@/server/payroll/definition';
import { PayrollFields } from '@/components/payroll-fields';
import { PayrollUploadResume } from '@/components/payroll-upload-resume';
import { PayrollActionForm } from '@/components/payroll-action-form';
import {
  saveEmployerAction,
  issueEmployeeInviteAction,
  uploadEmployerPayrollAction,
} from './actions';
export default async function EmployerPayrollPage() {
  const g = await payrollGuard('portal');
  const data = await withTenantContext(g.ctx, async (tx) => {
    const rows = await tx.payrollIntake.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const attachments = await tx.payrollAttachment.findMany({
      where: { intakeId: { in: rows.map((r) => r.id) }, audience: 'EMPLOYER' },
      orderBy: { createdAt: 'asc' },
    });
    return { rows, attachments };
  });
  return (
    <main className="p-6 max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">Personalfragebogen für Arbeitgeber</h1>
      <p>
        Hier sehen Sie ausschließlich die ausdrücklich für Sie freigegebenen Vorgänge.
        Arbeitnehmerangaben und persönliche Anlagen gehen direkt an die Lohnbearbeitung der Kanzlei.
      </p>
      <p className="card p-4">{DATEV_GATE_MESSAGE}</p>
      {data.rows.length === 0 && <p>Keine freigegebenen aktiven Personalvorgänge.</p>}
      {data.rows.map((item) => {
        const fields = (item.schemaSnapshot as unknown as typeof PAYROLL_SCHEMA).employer;
        const editable = ['DRAFT', 'RETURNED'].includes(item.status);
        return (
          <section className="card p-5 space-y-5" key={item.id}>
            <h2 className="text-xl font-semibold">{item.employeeLabel}</h2>
            <p>
              Status {item.status} · Arbeitgeber {item.employerConfirmedAt ? 'bestätigt' : 'offen'}{' '}
              · Arbeitnehmer {item.employeeSubmittedAt ? 'abgegeben' : 'offen'}
            </p>
            {item.reviewNote && <p>{item.reviewNote}</p>}
            {editable ? (
              <>
                {!item.employerConfirmedAt ? (
                  <PayrollActionForm action={saveEmployerAction} label="Auswahl speichern">
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="revision" value={item.revision} />
                    <PayrollFields
                      fields={fields}
                      answers={item.employerAnswers as Record<string, string>}
                    />
                    <label className="block">
                      Aktion
                      <select className="input" name="submit">
                        <option value="0">Zwischenstand speichern</option>
                        <option value="1">Beschäftigung und Vergütung bestätigen</option>
                      </select>
                    </label>
                    <label className="block">
                      <input type="checkbox" name="confirmed" /> Ich bestätige die Beschäftigungs-
                      und Vergütungsangaben als berechtigter Arbeitgeberkontakt.
                    </label>
                  </PayrollActionForm>
                ) : (
                  <>
                    <p>
                      Arbeitgeberteil bestätigt. Für Korrekturen eine Rückgabe durch die Kanzlei
                      anfordern.
                    </p>
                    <PayrollFields
                      fields={fields}
                      answers={item.employerAnswers as Record<string, string>}
                      disabled
                    />
                  </>
                )}
                {!item.employeeSubmittedAt && (
                  <PayrollActionForm
                    action={issueEmployeeInviteAction}
                    label="Persönlichen Arbeitnehmerlink erstellen"
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <p>
                      Nur an die betroffene Person sicher weitergeben. Neue Ausstellung widerruft
                      frühere Links und ihre Sessions. Es erfolgt kein automatischer Versand.
                    </p>
                  </PayrollActionForm>
                )}
                {!item.employerConfirmedAt && (
                  <PayrollActionForm
                    action={uploadEmployerPayrollAction}
                    label="Arbeitgebernachweis hochladen"
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" />
                    <p>
                      PDF/PNG/JPEG bis 25 MiB. Persönliche Arbeitnehmernachweise bitte über den
                      getrennten Link einreichen lassen.
                    </p>
                  </PayrollActionForm>
                )}
              </>
            ) : (
              <PayrollFields
                fields={fields}
                answers={item.employerAnswers as Record<string, string>}
                disabled
              />
            )}
            <ul>
              {data.attachments
                .filter((a) => a.intakeId === item.id)
                .map((a) => (
                  <li key={a.id}>
                    {a.status === 'COMPLETE' ? (
                      <a
                        className="underline"
                        href={'/api/portal/payroll/' + item.id + '/attachments/' + a.id}
                      >
                        {a.filename}
                      </a>
                    ) : (
                      a.filename + ' – Upload offen'
                    )}
                    {a.status === 'PENDING' && editable && !item.employerConfirmedAt && (
                      <PayrollUploadResume
                        action={uploadEmployerPayrollAction}
                        id={a.id}
                        intakeId={item.id}
                      />
                    )}
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
