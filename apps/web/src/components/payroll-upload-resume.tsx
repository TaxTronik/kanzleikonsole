import { PayrollActionForm, type PayrollActionResult } from './payroll-action-form';

export function PayrollUploadResume({
  action,
  id,
  intakeId,
}: {
  action: (data: FormData) => Promise<PayrollActionResult>;
  id: string;
  intakeId?: string;
}) {
  return (
    <details className="my-2 rounded border p-3">
      <summary>Unterbrochenen Upload wiederaufnehmen</summary>
      <PayrollActionForm action={action} label="Vorhandenes Journal abschließen" resumeId={id}>
        {intakeId && <input type="hidden" name="id" value={intakeId} />}
        <p>
          Die bereits gespeicherte Version wird zuerst geprüft. Falls der Speichertransfer noch
          fehlt, dieselbe Originaldatei erneut auswählen. Es entsteht kein neuer Anlagenvorgang.
        </p>
        <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" />
      </PayrollActionForm>
    </details>
  );
}
