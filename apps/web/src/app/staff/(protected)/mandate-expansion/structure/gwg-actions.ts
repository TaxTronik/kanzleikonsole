'use server';
import { z } from 'zod';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';
import { formFlag, parseFormData } from '@/server/actions/form-data';
import { revalidatePath } from 'next/cache';
import {
  BindGwgStructureInput,
  bindGwgStructureTx,
} from '@/server/mandate-expansion/gwg-structure';

/** Formularfassung: Revision als Zahl (wie bisher `Number(…)`), Bestätigung als Haken. */
const BindGwgStructureForm = BindGwgStructureInput.extend({
  expectedBindingRevision: z.preprocess(
    (value) => Number(value),
    BindGwgStructureInput.shape.expectedBindingRevision,
  ),
  confirmed: formFlag('on', BindGwgStructureInput.shape.confirmed),
});
export async function bindGwgStructureAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const input = parseFormData(BindGwgStructureForm, form, {
    absentAsNull: true,
    errorMessage:
      'Prüfung, Strukturversion, erläuternden Vermerk und ausdrückliche Bestätigung angeben.',
  });
  if (!input.ok) return input;
  const result = await withStaff(
    async (tx, { session }) => {
      await bindGwgStructureTx(tx, session, input.data);
    },
    { module: 'mandateStructure', revalidate: '/staff/mandate-expansion/structure' },
  );
  if (result.ok) revalidatePath(`/staff/clients/${input.data.clientId}/gwg`);
  return result;
}
