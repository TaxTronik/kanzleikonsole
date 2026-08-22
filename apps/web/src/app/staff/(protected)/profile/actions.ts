'use server';

import { compare, hash } from 'bcryptjs';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { checkRateLimit } from '@/server/rate-limit';
import { revokeAllSessions } from '@/server/auth/revocation';
import { toActionError } from '@/server/auth/rbac';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { validateStaffPasswordPair } from '@/lib/staff-password-policy';

const PASSWORD_CHANGE_LIMIT = { max: 5, windowSec: 15 * 60 };

export async function changeOwnPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx } = guard;

  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');
  const validationError = validateStaffPasswordPair(newPassword, confirmPassword);
  if (!currentPassword || validationError) {
    return { ok: false, error: validationError ?? 'Das aktuelle Passwort fehlt.' };
  }

  const limit = await checkRateLimit(`staff-password-change:${staffId}`, PASSWORD_CHANGE_LIMIT);
  if (!limit.ok) {
    return { ok: false, error: 'Zu viele Versuche. Bitte warten Sie einige Minuten.' };
  }

  try {
    const current = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findUnique({
        where: { id: staffId },
        select: { passwordHash: true, active: true },
      }),
    );
    if (!current?.active) throw new ActionError('Benutzerkonto nicht gefunden oder deaktiviert.');
    if (!(await compare(currentPassword, current.passwordHash))) {
      return { ok: false, error: 'Das aktuelle Passwort ist nicht korrekt.' };
    }
    if (await compare(newPassword, current.passwordHash)) {
      return { ok: false, error: 'Das neue Passwort muss sich vom aktuellen unterscheiden.' };
    }

    const passwordHash = await hash(newPassword, 12);
    await withTenantContext(ctx, async (tx) => {
      const updated = await tx.staffUser.updateMany({
        where: { id: staffId, passwordHash: current.passwordHash, active: true },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      if (updated.count !== 1) {
        throw new ActionError(
          'Das Passwort wurde zwischenzeitlich geändert. Bitte melden Sie sich erneut an.',
        );
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.password.change',
        resourceType: 'staff_user',
        resourceId: staffId,
        after: { changedBy: 'self' },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  // Auch die aktuelle Sitzung wird absichtlich ungültig. Der Client ruft danach
  // den hosttreuen Logout-Endpunkt auf, damit zusätzlich alle Cookies verschwinden.
  await revokeAllSessions('staff', staffId);
  return { ok: true };
}
