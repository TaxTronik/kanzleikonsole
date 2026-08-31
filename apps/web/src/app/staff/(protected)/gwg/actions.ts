'use server';
import { z } from 'zod';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';
import { changeGwgPersonLinkTx } from '@/server/gwg/person-links';
const Schema = z.object({
  left: z.string().uuid(),
  right: z.string().uuid(),
  remove: z.boolean(),
  confirmed: z.literal(true),
});
export async function changePersonLinkAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = Schema.safeParse({
    left: form.get('left'),
    right: form.get('right'),
    remove: form.get('remove') === 'true',
    confirmed: form.get('confirmed') === 'on',
  });
  if (!parsed.success)
    return {
      ok: false,
      error: 'Bitte zwei Personen wählen und die Entscheidung ausdrücklich bestätigen.',
    };
  return withStaff(
    async (tx, { session }) => {
      await changeGwgPersonLinkTx(tx, session, parsed.data);
    },
    { revalidate: '/staff/gwg' },
  );
}
