import type { PayrollField } from '@/server/payroll/definition';
export function PayrollFields({
  fields,
  answers,
  disabled = false,
}: {
  fields: PayrollField[];
  answers: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {fields.map((field) => (
        <label key={field.key} className={field.type === 'textarea' ? 'md:col-span-2' : ''}>
          {field.label}
          {field.required ? ' *' : ''}
          {field.type === 'select' ? (
            <select
              className="input block w-full"
              name={field.key}
              defaultValue={answers[field.key] ?? ''}
              disabled={disabled}
            >
              <option value="">Bitte wählen</option>
              {field.options?.map((option) => (
                <option key={option} value={option}>
                  {(
                    {
                      ASSIGNED: 'Bereits vergeben',
                      NOT_ASSIGNED: 'Noch nicht vergeben',
                      STATUTORY: 'Gesetzlich',
                      PRIVATE: 'Privat',
                      UNCLEAR: 'Noch zu klären',
                      YES: 'Ja',
                      NO: 'Nein',
                      MONTHLY: 'Monatlich',
                      HOURLY: 'Je Stunde',
                      REGULAR: 'Regulär',
                      MINIJOB: 'Minijob',
                      TRAINING: 'Ausbildung',
                      OTHER: 'Sonstige',
                      UNKNOWN: 'Noch zu prüfen',
                      POSSIBLY_REQUIRED: 'Voraussichtlich erforderlich',
                      NOT_EXPECTED: 'Voraussichtlich nicht erforderlich',
                    } as Record<string, string>
                  )[option] ?? option}
                </option>
              ))}
            </select>
          ) : field.type === 'textarea' ? (
            <textarea
              className="input block w-full"
              name={field.key}
              maxLength={4000}
              rows={3}
              defaultValue={answers[field.key] ?? ''}
              disabled={disabled}
            />
          ) : (
            <input
              className="input block w-full"
              name={field.key}
              type={field.type === 'date' ? 'date' : 'text'}
              inputMode={field.type === 'number' ? 'decimal' : undefined}
              maxLength={4000}
              defaultValue={answers[field.key] ?? ''}
              disabled={disabled}
            />
          )}
        </label>
      ))}
    </div>
  );
}
