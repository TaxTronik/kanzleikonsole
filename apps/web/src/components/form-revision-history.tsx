import { readFormSchema } from '@/server/forms/schema-snapshot';

export function FormRevisionHistory({
  rows,
  surface,
}: {
  rows: Array<{
    id: string;
    sequence: number;
    submittedAt: Date;
    schemaSnapshot: unknown;
    answers: unknown;
    files: Array<{ id: string; fieldKey: string; documentVersionId: string; sha256: string }>;
  }>;
  surface: 'staff' | 'portal';
}) {
  if (!rows.length) return null;
  return (
    <section className="card p-5 mt-6 space-y-3">
      <h2 className="text-lg font-semibold">Erhaltene Einreichungsstände vor Rückfragen</h2>
      <p>
        Unveränderte Fragen, Antworten und Dateiversionen der jeweiligen Abgabe. Spätere Korrekturen
        ändern diese Stände nicht.
      </p>
      {rows.map((row) => {
        const schema = readFormSchema(row.schemaSnapshot, {
          name: '',
          description: null,
          introMd: null,
          fields: [],
        });
        const answers = row.answers as Record<string, unknown>;
        return (
          <details key={row.id} className="border-t py-2">
            <summary>
              Einreichung {row.sequence} ·{' '}
              {row.submittedAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
            </summary>
            <dl className="space-y-3 p-3">
              {schema.fields
                .filter((f) => f.type !== 'INFO_TEXT')
                .map((field) => {
                  const file = row.files.find((f) => f.fieldKey === field.key);
                  const value = answers[field.key];
                  return (
                    <div key={field.key}>
                      <dt className="font-semibold">{field.label}</dt>
                      <dd className="whitespace-pre-wrap">
                        {file ? (
                          <>
                            <a
                              className="underline"
                              href={'/api/' + surface + '/form-revision-files/' + file.id}
                            >
                              Dateiversion dieser Einreichung herunterladen
                            </a>
                            <p className="text-xs break-all">SHA-256: {file.sha256}</p>
                          </>
                        ) : value === null || value === undefined ? (
                          '—'
                        ) : typeof value === 'boolean' ? (
                          value ? (
                            'Ja'
                          ) : (
                            'Nein'
                          )
                        ) : typeof value === 'string' || typeof value === 'number' ? (
                          String(value)
                        ) : (
                          JSON.stringify(value)
                        )}
                      </dd>
                    </div>
                  );
                })}
            </dl>
          </details>
        );
      })}
    </section>
  );
}
