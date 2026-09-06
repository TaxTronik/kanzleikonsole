import type { Metadata } from 'next';
import { guestRead } from '@/server/payroll/capability';
import { PayrollFields } from '@/components/payroll-fields';
import { PayrollActionForm } from '@/components/payroll-action-form';
import { PayrollUploadResume } from '@/components/payroll-upload-resume';
import { EmployeeEntry } from './entry';
import { saveEmployeeAction, uploadEmployeeAction, leaveEmployeeAction } from './actions';
export const metadata: Metadata = {
  title: 'Persönlicher Personalfragebogen',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function EmployeePayrollPage() {
  const item = await guestRead();
  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Persönlicher Personalfragebogen</h1>
      <EmployeeEntry hasSession={!!item} />
      {!item ? (
        <p>
          Für einen abgelaufenen oder bereits verwendeten Link bitte einen neuen Link anfordern.
        </p>
      ) : (
        <>
          <p>
            Ihre Angaben und Anlagen sind für die Lohnbearbeitung der Kanzlei bestimmt. Andere
            Mandantenkontakte erhalten dadurch keinen Zugriff auf Ihre Angaben.
          </p>
          <p>
            Abgabe bis{' '}
            {new Date(item.expiresAt).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}.
            Status: {item.status}. Sitzung auf diesen Vorgang beschränkt.
          </p>
          {item.reviewNote && <p className="card p-3">Rückfrage der Kanzlei: {item.reviewNote}</p>}
          {!item.submitted && ['DRAFT', 'RETURNED'].includes(item.status) ? (
            <PayrollActionForm action={saveEmployeeAction} label="Auswahl speichern">
              <input type="hidden" name="revision" value={item.revision} />
              <PayrollFields fields={item.schema} answers={item.answers} />
              <p>
                Steuer-ID wird auf Format geprüft, IBAN und Versicherungsnummer zusätzlich auf
                Prüfziffer. Das bestätigt keine Vergabe oder Kontoinhaberschaft. Noch nicht
                vergebene Nummern bitte ausdrücklich kennzeichnen.
              </p>
              <label className="block">
                Aktion
                <select className="input" name="submit">
                  <option value="0">Zwischenstand speichern</option>
                  <option value="1">Angaben an die Kanzlei abgeben</option>
                </select>
              </label>
              <label className="block">
                <input type="checkbox" name="confirmed" /> Ich habe meine Angaben geprüft. Nach der
                Abgabe sind Änderungen nur nach Rückgabe durch die Kanzlei möglich.
              </label>
            </PayrollActionForm>
          ) : (
            <div className="card p-5">
              <p>
                Ihre Angaben wurden abgegeben. Für Korrekturen kontaktieren Sie bitte die Kanzlei.
              </p>
              <PayrollFields fields={item.schema} answers={item.answers} disabled />
            </div>
          )}
          <section className="card p-5 space-y-3">
            <h2 className="text-lg font-semibold">Persönliche Anlagen</h2>
            <p>
              Nur erforderliche Nachweise hochladen, keine Diagnosen oder nicht angeforderten
              Ausweiskopien. PDF/PNG/JPEG, jeweils höchstens 25 MiB; maximal 20 Anlagen.
            </p>
            {!item.submitted && ['DRAFT', 'RETURNED'].includes(item.status) && (
              <PayrollActionForm action={uploadEmployeeAction} label="Anlage sicher hochladen">
                <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" />
              </PayrollActionForm>
            )}
            <ul>
              {item.attachments.map((a) => (
                <li key={a.id}>
                  {a.status === 'COMPLETE' ? (
                    <a className="underline" href={'/payroll/employee/attachments/' + a.id}>
                      {a.filename}
                    </a>
                  ) : (
                    a.filename + ' – Upload noch offen'
                  )}
                  {a.status === 'PENDING' &&
                    !item.submitted &&
                    ['DRAFT', 'RETURNED'].includes(item.status) && (
                      <PayrollUploadResume action={uploadEmployeeAction} id={a.id} />
                    )}
                </li>
              ))}
            </ul>
          </section>
          <form action={leaveEmployeeAction}>
            <button className="btn">Sitzung beenden</button>
          </form>
        </>
      )}
    </main>
  );
}
