'use client';
import { useActionState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CASE_DEFINITIONS, type CaseKind } from '@/server/client-assistance/definitions';
type Result = { ok: boolean; error?: string; id?: string };
export function ClientAssistanceForm({
  action,
  clientId,
  kind,
  item,
  sourceOptions = [],
}: {
  action: (previous: Result | null, data: FormData) => Promise<Result>;
  clientId: string;
  kind: CaseKind;
  sourceOptions?: Array<{ id: string; title: string }>;
  item?: {
    id: string;
    revision: number;
    sourceDocumentVersionId?: string | null;
    answers: Record<string, string>;
    status: string;
    schemaSnapshot?: {
      fields: Array<{ key: string; label: string; type?: string; required?: boolean }>;
    };
  };
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (state?.ok && state.id && !item)
      router.replace(pathname + '?clientId=' + clientId + '&kind=' + kind + '&id=' + state.id);
  }, [state, item, router, pathname, clientId, kind]);
  const definition = CASE_DEFINITIONS[kind];
  const fields = item?.schemaSnapshot?.fields ?? definition.fields;
  const locked = item && !['DRAFT', 'RETURNED'].includes(item.status);
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={item?.id ?? ''} />
      <input type="hidden" name="revision" value={item?.revision ?? 0} />
      <h2 className="text-xl font-semibold">{definition.title}</h2>
      <p className="text-sm text-muted">
        Angaben werden versioniert. Einreichung ist keine fachliche Freigabe. Unbekannte Punkte
        offen benennen.
      </p>
      {fields.map((field) => (
        <label key={field.key} className="block">
          <span className="block text-sm font-medium">
            {field.label}
            {field.required ? ' *' : ''}
          </span>
          {field.type === 'textarea' ? (
            <textarea
              name={'answer.' + field.key}
              defaultValue={item?.answers[field.key] ?? ''}
              rows={4}
              maxLength={12000}
              disabled={!!locked}
              className="input w-full"
            />
          ) : (
            <input
              name={'answer.' + field.key}
              type={field.type === 'date' ? 'date' : 'text'}
              inputMode={field.type === 'money' ? 'decimal' : undefined}
              defaultValue={item?.answers[field.key] ?? ''}
              maxLength={12000}
              disabled={!!locked}
              className="input w-full"
            />
          )}
        </label>
      ))}
      {kind === 'BEWIRTUNG' && !item?.sourceDocumentVersionId && !locked && (
        <label className="block">
          Geprüfter Originalbeleg aus der Dokumentablage
          <select name="sourceVersionId" className="input w-full" defaultValue="">
            <option value="">Bitte auswählen</option>
            {sourceOptions.map((source) => (
              <option key={source.id} value={source.id}>
                {source.title}
              </option>
            ))}
          </select>
          <span className="text-sm">Fehlenden Beleg zuerst im Bereich Dokumente hochladen.</span>
        </label>
      )}
      {item?.sourceDocumentVersionId && (
        <p className="text-sm">
          Der ursprüngliche Belegstand ist fest mit diesem Vorgang verbunden.
        </p>
      )}
      {!locked && (
        <>
          <label className="flex gap-2">
            <input type="checkbox" name="confirmed" />
            Ich bestätige die Richtigkeit meiner Angaben.
          </label>
          <div className="flex gap-3">
            <button name="intent" value="save" disabled={pending} className="btn-secondary">
              Entwurf speichern
            </button>
            <button name="intent" value="submit" disabled={pending} className="btn-primary">
              Einreichen
            </button>
          </div>
        </>
      )}
      {state && (
        <p role="status" className={state.ok ? 'text-success' : 'text-danger'}>
          {state.ok ? 'Gespeichert. Die Übersicht wurde aktualisiert.' : state.error}
        </p>
      )}
    </form>
  );
}
