'use server';
import { z } from 'zod';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';
import { formFlag, parseFormData } from '@/server/actions/form-data';
import { changeGwgPersonLinkTx } from '@/server/gwg/person-links';
const Schema = z.object({
  left: z.string().uuid(),
  right: z.string().uuid(),
  remove: formFlag('true'),
  confirmed: formFlag('on', z.literal(true)),
});
export async function changePersonLinkAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(Schema, form, {
    absentAsNull: true,
    errorMessage: 'Bitte zwei Personen wählen und die Entscheidung ausdrücklich bestätigen.',
  });
  if (!parsed.ok) return parsed;
  return withStaff(
    async (tx, { session }) => {
      await changeGwgPersonLinkTx(tx, session, parsed.data);
    },
    { revalidate: '/staff/gwg' },
  );
}
