import { type CaseKind } from './definitions';
export function assistanceFormInput(form: FormData) {
  const kind = String(form.get('kind')) as CaseKind;
  return {
    id: String(form.get('id') ?? '') || undefined,
    clientId: String(form.get('clientId')),
    kind,
    expectedRevision: Number(form.get('revision') ?? 0),
    submit: form.get('intent') === 'submit',
    confirmed: form.get('confirmed') === 'on',
    sourceVersionId: String(form.get('sourceVersionId') ?? ''),
    answers: Object.fromEntries(
      [...form.entries()]
        .filter(([key]) => key.startsWith('answer.'))
        .map(([key, value]) => [key.slice(7), String(value)]),
    ),
  };
}
