import Link from 'next/link';
import { withTenantContext } from '@taxtronik/db';
import { payrollGuard, payrollTx } from '@/server/payroll/service';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { PayrollActionForm } from '@/components/payroll-action-form';
import { PayrollFields } from '@/components/payroll-fields';
import { PayrollUploadResume } from '@/components/payroll-upload-resume';
import { PAYROLL_SCHEMA, DATEV_GATE_MESSAGE } from '@/server/payroll/definition';
import { isUuid } from '@/lib/uuid';
import { requireStaffPage } from '@/server/auth/staff-page';
import {
  createPayrollAction,
  saveEmployerDraftAction,
  issueEmployeeInviteAction,
  reviewPayrollAction,
  confirmPayrollNumbersAction,
  recordImmediateRegistrationAction,
  checkDatevGateAction,
  createPayrollExportAction,
  uploadPayrollAction,
} from './actions';

async function loadPayrollDetail(id: string) {
  return payrollTx('staff', id, async (tx, item) => ({
    item,
    employee: await tx.payrollEmployeeData.findUnique({ where: { intakeId: item.id } }),
    attachments: await tx.payrollAttachment.findMany({
      where: { intakeId: item.id },
      orderBy: { createdAt: 'desc' },
    }),
    exports: await tx.payrollExport.findMany({
      where: { intakeId: item.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    revisions: await tx.payrollRevision.findMany({
      where: { intakeId: item.id },
      select: { revision: true, actorType: true, createdAt: true },
      orderBy: { revision: 'desc' },
      take: 20,
    }),
    task: await tx.payrollExternalTask.findUnique({
      where: { intakeId_kind: { intakeId: item.id, kind: 'SOFORTMELDUNG' } },
    }),
  }));
}

type PayrollDetail = Awaited<ReturnType<typeof loadPayrollDetail>>;

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  await requireStaffPage();
  const g = await payrollGuard('staff');
  if (!('staffId' in g)) return null;
  const data = await withTenantContext(g.ctx, async (tx) => {
    const clients = await tx.client.findMany({
      where: {
        allowActive: true,
        mandateEndedAt: null,
        ...(await accessibleClientsWhereFor(tx, g.session)),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const contacts = await tx.clientContact.findMany({
      where: { active: true, clientId: { in: clients.map((c) => c.id) } },
      select: { id: true, clientId: true, fullName: true },
    });
    const rows = await tx.payrollIntake.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return { clients, contacts, rows };
  });
  const { id } = await searchParams;
  const selected = id && isUuid(id) ? id : data.rows[0]?.id;
  const detail = selected ? await loadPayrollDetail(selected) : null;
  return (
    <main className="p-6 max-w-7xl space-y-6">
      <h1 className="text-2xl font-bold">Personalfragebogen</h1>
      <p>
        Neuanlage vorbereiten, getrennte Angaben einholen und prüfen. Zugriff nur mit PAYROLL_MANAGE
        und aktuellem Mandatszugriff. Lohnanlagen erscheinen nicht in der allgemeinen
        Dokumentensuche.
      </p>
      <div className="card border-amber-300 p-4">{DATEV_GATE_MESSAGE}</div>
      <details className="card p-4">
        <summary className="font-semibold">Neuen Personalvorgang vorbereiten</summary>
        <PayrollActionForm action={createPayrollAction} label="Einzelvorgang anlegen">
          <label className="block">
            Mandat
            <select className="input" name="clientId" required>
              <option value="">Bitte wählen</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Ausdrücklich berechtigter Arbeitgeberkontakt
            <select className="input" name="contactId" required>
              <option value="">Bitte wählen</option>
              {data.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {data.clients.find((x) => x.id === c.clientId)?.name}: {c.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Bezeichnung der Person
            <input className="input" name="label" maxLength={150} required />
          </label>
          <label className="block">
            Abgabe-/Zugriffsende
            <input className="input" name="due" type="date" required />
          </label>
        </PayrollActionForm>
      </details>
      <div className="grid lg:grid-cols-[240px_1fr] gap-6">
        <aside className="space-y-2">
          {data.rows.map((row) => (
            <Link
              className="block rounded border p-3"
              key={row.id}
              href={'/staff/payroll?id=' + row.id}
            >
              {row.employeeLabel}
              <br />
              <small>
                {row.status} · Revision {row.revision}
              </small>
            </Link>
          ))}
        </aside>
        {detail ? <PayrollDetailView detail={detail} /> : <p>Noch kein Personalvorgang.</p>}
      </div>
    </main>
  );
}

function PayrollDetailView({ detail }: { detail: PayrollDetail }) {
  const item = detail.item;
  const schema = item.schemaSnapshot as unknown as typeof PAYROLL_SCHEMA;
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold">{item.employeeLabel}</h2>
      <p>
        Revision {item.revision} · {item.status} · Arbeitgeber{' '}
        {item.employerConfirmedAt ? 'bestätigt' : 'offen'} · Arbeitnehmer{' '}
        {item.employeeSubmittedAt ? 'abgegeben' : 'offen'}
        {item.revokedAt ? ' · ZUGRIFF WIDERRUFEN' : ''}
      </p>
      {['DRAFT', 'RETURNED'].includes(item.status) && !item.revokedAt && (
        <PayrollActionForm
          action={issueEmployeeInviteAction}
          label="Neuen persönlichen Arbeitnehmerlink erstellen"
        >
          <input type="hidden" name="id" value={item.id} />
          <p>
            Einmallink vertraulich an die Person übermitteln. Neue Ausstellung widerruft frühere
            Links und ihre Sessions. Es wird keine E-Mail versandt.
          </p>
        </PayrollActionForm>
      )}
      <section className="card p-5">
        <h3 className="text-lg font-semibold mb-3">Beschäftigung und Vergütung</h3>
        {['DRAFT', 'RETURNED'].includes(item.status) && !item.employerConfirmedAt ? (
          <PayrollActionForm action={saveEmployerDraftAction} label="Kanzleientwurf speichern">
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="revision" value={item.revision} />
            <input type="hidden" name="submit" value="0" />
            <PayrollFields
              fields={schema.employer}
              answers={item.employerAnswers as Record<string, string>}
            />
            <p>
              Die verbindliche Bestätigung erfolgt durch den ausgewählten Arbeitgeberkontakt im
              Portal.
            </p>
          </PayrollActionForm>
        ) : (
          <PayrollFields
            fields={schema.employer}
            answers={item.employerAnswers as Record<string, string>}
            disabled
          />
        )}
      </section>
      <section className="card p-5">
        <h3 className="text-lg font-semibold mb-3">Arbeitnehmerangaben – nur Lohnbearbeitung</h3>
        <PayrollFields
          fields={schema.employee}
          answers={(detail.employee?.answers ?? {}) as Record<string, string>}
          disabled
        />
      </section>
      <section className="card p-5 space-y-3">
        <h3 className="text-lg font-semibold">DATEV-Zuordnung bestätigen</h3>
        <PayrollActionForm action={confirmPayrollNumbersAction} label="Geprüfte Nummern speichern">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="revision" value={item.revision} />
          {(
            [
              ['advisorNumber', 'Beraternummer', item.advisorNumber],
              ['clientNumber', 'Mandantennummer', item.clientNumber],
              ['personnelNumber', 'Personalnummer', item.personnelNumber],
            ] as const
          ).map(([key, label, value]) => (
            <label className="block" key={key}>
              {label}
              <input
                className="input"
                name={key}
                defaultValue={value ?? ''}
                inputMode="numeric"
                required
              />
            </label>
          ))}
          <label>
            <input type="checkbox" name="confirmed" required /> Mit dem Zielbestand abgeglichen;
            keine automatische Nummernvergabe.
          </label>
        </PayrollActionForm>
      </section>
      <section className="card p-5 space-y-3">
        <h3 className="text-lg font-semibold">Sofortmeldung – gesonderte externe Aufgabe</h3>
        <p>
          Status: {detail.task?.status ?? 'OPEN'}. Die Anwendung prüft keine Branchenpflicht und
          versendet keine Meldung.
        </p>
        {detail.task?.evidence && <p>{detail.task.evidence}</p>}
        <PayrollActionForm
          action={recordImmediateRegistrationAction}
          label="Externe Prüfung dokumentieren"
        >
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="revision" value={item.revision} />
          <select className="input" name="status">
            <option value="NOT_REQUIRED">Nach Einzelfallprüfung nicht erforderlich</option>
            <option value="EVIDENCE_RECORDED">Externe Meldung durch Nachweis dokumentiert</option>
          </select>
          <textarea
            className="input block w-full"
            name="evidence"
            minLength={10}
            maxLength={2000}
            placeholder="Prüfgrund oder externes Protokoll/Referenz und Ereignisdatum"
            required
          />
        </PayrollActionForm>
      </section>
      <section className="card p-5 space-y-3">
        <h3 className="text-lg font-semibold">Anlagen und Upload-Wiederaufnahme</h3>
        {['DRAFT', 'RETURNED'].includes(item.status) && (
          <PayrollActionForm action={uploadPayrollAction} label="Interne Lohnanlage hochladen">
            <input type="hidden" name="id" value={item.id} />
            <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" />
            <p>
              PDF/PNG/JPEG bis 25 MiB. Bei unterbrochenem Commit dieselbe Datei erneut wählen; die
              angezeigte Upload-ID wird weiterverwendet.
            </p>
          </PayrollActionForm>
        )}
        <ul>
          {detail.attachments.map((a) => (
            <li key={a.id} className="py-1">
              {a.status === 'COMPLETE' ? (
                <a
                  className="underline"
                  href={'/api/staff/payroll/' + item.id + '/attachments/' + a.id}
                >
                  {a.filename}
                </a>
              ) : (
                a.filename + ' – Upload offen'
              )}{' '}
              · {a.audience} · r{a.revision}
              {a.status === 'PENDING' &&
                a.audience === 'STAFF' &&
                ['DRAFT', 'RETURNED'].includes(item.status) &&
                !item.revokedAt &&
                !detail.exports.some((e) => e.attachmentId === a.id) && (
                  <PayrollUploadResume action={uploadPayrollAction} id={a.id} intakeId={item.id} />
                )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card p-5 space-y-3">
        <h3 className="text-lg font-semibold">Kanzleiprüfung und Rückgabe</h3>
        <PayrollActionForm action={reviewPayrollAction} label="Prüfentscheidung speichern">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="revision" value={item.revision} />
          <select className="input" name="decision">
            <option value="REVIEWED">Eingereichten Stand geprüft</option>
            <option value="RETURNED">Beide Teile zur Korrektur zurückgeben</option>
            <option value="REVOKED">Vorgangszugänge widerrufen</option>
          </select>
          <label className="block">
            Vermerk für Arbeitgeber UND Arbeitnehmer (keine vertraulichen Arbeitnehmerdetails)
            <textarea
              className="input block w-full"
              name="note"
              required
              minLength={10}
              maxLength={1500}
            />
          </label>
        </PayrollActionForm>
      </section>
      <section className="card p-5 space-y-3">
        <h3 className="text-lg font-semibold">Prüfexporte</h3>
        <PayrollActionForm action={createPayrollExportAction} label="Geprüften Stand erzeugen">
          <input type="hidden" name="id" value={item.id} />
          <select className="input" name="kind">
            <option value="PDF">PDF-Personalfragebogen</option>
            <option value="ZIP">PDF und gebundene Anlagen als ZIP (max. 20 MiB Quellen)</option>
          </select>
        </PayrollActionForm>
        <PayrollActionForm
          action={checkDatevGateAction}
          label="DATEV-Importgate prüfen und protokollieren"
        >
          <input type="hidden" name="id" value={item.id} />
        </PayrollActionForm>
        <ul>
          {detail.exports.map((e) => (
            <li key={e.id} className="border-t py-2">
              r{e.revision} · {e.kind} · {e.status}
              <p>{e.explanation}</p>
              {e.status === 'COMPLETE' && e.attachmentId && (
                <a
                  className="underline"
                  href={'/api/staff/payroll/' + item.id + '/attachments/' + e.attachmentId}
                >
                  Export herunterladen
                </a>
              )}
              {e.status === 'PENDING' &&
                e.attachmentId &&
                e.revision === item.revision &&
                item.status === 'REVIEWED' &&
                !item.revokedAt && (
                  <PayrollActionForm
                    action={createPayrollExportAction}
                    label="Prüfexport wiederaufnehmen"
                    resumeId={e.attachmentId}
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="kind" value={e.kind} />
                  </PayrollActionForm>
                )}
            </li>
          ))}
        </ul>
      </section>
      <details>
        <summary>Revisionsprotokoll</summary>
        <ul>
          {detail.revisions.map((r) => (
            <li key={r.revision}>
              Revision {r.revision}: {r.actorType} · {r.createdAt.toLocaleString('de-DE')}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
