'use server';

import { z } from 'zod';
import { parseFormData, withStaff, type ActionResult } from '@/server/actions/staff-action';

const IdSchema = z.object({ id: z.string().uuid() });

export async function markNotificationReadByIdAction(input: { id: string }): Promise<ActionResult> {
  const parsed = IdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { staffId }) => {
      await tx.notification.updateMany({
        where: {
          id: parsed.data.id,
          OR: [{ staffId }, { staffId: null }],
          readAt: null,
        },
        data: { readAt: new Date() },
      });
    },
    { revalidate: ['/staff/notifications', '/staff/dashboard'] },
  );
}

export async function markNotificationReadAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // F6: UUID-Validation statt nur typeof — sonst werfen Prisma-Updates erst
  // zur Laufzeit mit "Invalid uuid".
  const parsed = parseFormData(IdSchema, formData);
  if (!parsed.ok) return parsed;
  return markNotificationReadByIdAction(parsed.data);
}

export async function markAllNotificationsReadAction(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return withStaff(
    async (tx, { staffId }) => {
      await tx.notification.updateMany({
        where: { OR: [{ staffId }, { staffId: null }], readAt: null },
        data: { readAt: new Date() },
      });
    },
    { revalidate: ['/staff/notifications', '/staff/dashboard'] },
  );
}
