'use server';

import { z } from 'zod';
import {
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

export interface ActionResult extends BaseActionResult {
  id?: string;
}

const BodySchema = z.string().min(1).max(5000);

export async function addNoteAction(input: { body: string }): Promise<ActionResult> {
  const parsed = BodySchema.safeParse(input.body);
  if (!parsed.success) return { ok: false, error: 'Notiz darf nicht leer sein.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const note = await tx.staffNote.create({
        data: { tenantId, staffId, body: parsed.data.trim() },
      });
      return { id: note.id };
    },
    { revalidate: '/staff/dashboard' },
  );
}

const UpdateSchema = z.object({
  id: z.string().uuid(),
  body: BodySchema,
});

export async function updateNoteAction(input: z.infer<typeof UpdateSchema>): Promise<ActionResult> {
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Notiz darf nicht leer sein.' };

  return withStaff(
    async (tx, { staffId }) => {
      const r = await tx.staffNote.updateMany({
        where: { id: parsed.data.id, staffId },
        data: { body: parsed.data.body.trim() },
      });
      if (r.count === 0) throw new ActionError('Notiz nicht gefunden.');
    },
    { revalidate: '/staff/dashboard' },
  );
}

export async function deleteNoteAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { staffId }) => {
      await tx.staffNote.deleteMany({
        where: { id: parsed.data.id, staffId },
      });
    },
    { revalidate: '/staff/dashboard' },
  );
}
