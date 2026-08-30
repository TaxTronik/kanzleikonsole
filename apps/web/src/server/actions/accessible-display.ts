'use server';

import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { ActionError, withStaff } from '@/server/actions/staff-action';
import { withPortalContext } from '@/server/actions/portal-action';
import type { TxClient } from '@taxtronik/db';
import {
  DISPLAY_OPTIONS_SELECT,
  displayOptionsFromProfile,
  displayOptionsToColumns,
  parseDisplayOptionsPatch,
  type DisplayOptionsPatch,
} from '@/lib/accessible-display-options';

type AccessibleDisplayResult = { ok: true } | { ok: false; error: string };

async function updateOptions(
  tx: TxClient,
  surface: 'staff' | 'portal',
  profile: { tenantId: string; actorId: string; clientId?: string },
  expectedProfileKey: string,
  patch: DisplayOptionsPatch,
) {
  const { tenantId, actorId, clientId } = profile;
  if (expectedProfileKey !== `${surface}:${tenantId}:${actorId}`) {
    throw new ActionError(
      'Das aktive Benutzerprofil hat sich geändert. Bitte öffnen Sie die Profileinstellungen erneut.',
    );
  }
  const where = { id: actorId, tenantId, active: true, ...(clientId ? { clientId } : {}) };
  const before =
    surface === 'staff'
      ? await tx.staffUser.findFirst({ where, select: DISPLAY_OPTIONS_SELECT })
      : await tx.clientContact.findFirst({ where, select: DISPLAY_OPTIONS_SELECT });
  if (!before) throw new ActionError('Benutzerprofil nicht gefunden oder deaktiviert.');
  const beforeOptions = displayOptionsFromProfile(before);
  if (
    Object.entries(patch).every(
      ([key, value]) => beforeOptions[key as keyof typeof patch] === value,
    )
  )
    return;
  const change = { where, data: displayOptionsToColumns(patch) };
  const updated =
    surface === 'staff'
      ? await tx.staffUser.updateMany(change)
      : await tx.clientContact.updateMany(change);
  if (updated.count !== 1) throw new ActionError('Benutzerprofil nicht gefunden oder deaktiviert.');
  await evidenceService.record(tx, {
    tenantId,
    actorType: surface === 'staff' ? 'STAFF' : 'CLIENT_CONTACT',
    actorId,
    action: `${surface}.accessible_display.options.change`,
    resourceType: surface === 'staff' ? 'staff_user' : 'client_contact',
    resourceId: actorId,
    before: Object.fromEntries(
      Object.keys(patch).map((key) => [key, beforeOptions[key as keyof typeof patch]]),
    ),
    after: { ...patch },
  });
}

export async function saveStaffAccessibleDisplayOptionsAction(
  expectedProfileKey: string,
  input: DisplayOptionsPatch,
): Promise<AccessibleDisplayResult> {
  const patch = parseDisplayOptionsPatch(input);
  if (!patch) return { ok: false, error: 'Ungültige Anzeigeoptionen.' };
  const result = await withStaff((tx, { tenantId, staffId }) =>
    updateOptions(tx, 'staff', { tenantId, actorId: staffId }, expectedProfileKey, patch),
  );
  if (!result.ok)
    return {
      ok: false,
      error: result.error ?? 'Anzeigeoptionen konnten nicht gespeichert werden.',
    };
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

export async function savePortalAccessibleDisplayOptionsAction(
  expectedProfileKey: string,
  input: DisplayOptionsPatch,
): Promise<AccessibleDisplayResult> {
  const patch = parseDisplayOptionsPatch(input);
  if (!patch) return { ok: false, error: 'Ungültige Anzeigeoptionen.' };
  const result = await withPortalContext((tx, { tenantId, contactId, clientId }) =>
    updateOptions(
      tx,
      'portal',
      { tenantId, actorId: contactId, clientId },
      expectedProfileKey,
      patch,
    ),
  );
  if (!result.ok)
    return {
      ok: false,
      error: result.error ?? 'Anzeigeoptionen konnten nicht gespeichert werden.',
    };
  revalidatePath('/portal', 'layout');
  return { ok: true };
}

export async function saveStaffAccessibleDisplayAction(
  expectedProfileKey: string,
  enabled: boolean,
): Promise<AccessibleDisplayResult> {
  if (typeof enabled !== 'boolean') return { ok: false, error: 'Ungültige Anzeigeeinstellung.' };

  const result = await withStaff(async (tx, { tenantId, staffId }) => {
    // A stale tab may still display a previous login/profile. This key is only
    // a comparison guard; every database identifier comes from the session.
    if (expectedProfileKey !== `staff:${tenantId}:${staffId}`) {
      throw new ActionError(
        'Das aktive Benutzerprofil hat sich geändert. Bitte öffnen Sie die Profileinstellungen erneut.',
      );
    }
    const where = { id: staffId, tenantId, active: true };
    const before = await tx.staffUser.findFirst({
      where,
      select: { accessibleDisplay: true },
    });
    if (!before) throw new ActionError('Benutzerkonto nicht gefunden oder deaktiviert.');
    if (before.accessibleDisplay === enabled) return;

    const updated = await tx.staffUser.updateMany({
      where,
      data: { accessibleDisplay: enabled },
    });
    if (updated.count !== 1) {
      throw new ActionError('Benutzerkonto nicht gefunden oder deaktiviert.');
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'staff.accessible_display.change',
      resourceType: 'staff_user',
      resourceId: staffId,
      before: { accessibleDisplay: before.accessibleDisplay },
      after: { accessibleDisplay: enabled },
    });
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? 'Die Anzeigeeinstellung konnte nicht gespeichert werden.',
    };
  }
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

export async function savePortalAccessibleDisplayAction(
  expectedProfileKey: string,
  enabled: boolean,
): Promise<AccessibleDisplayResult> {
  if (typeof enabled !== 'boolean') return { ok: false, error: 'Ungültige Anzeigeeinstellung.' };

  const result = await withPortalContext(async (tx, { tenantId, contactId, clientId }) => {
    // Profile switching in another tab changes the shared session cookie, not
    // the already rendered form. Never apply that old form to the new profile.
    if (expectedProfileKey !== `portal:${tenantId}:${contactId}`) {
      throw new ActionError(
        'Das aktive Benutzerprofil hat sich geändert. Bitte öffnen Sie die Profileinstellungen erneut.',
      );
    }
    const where = { id: contactId, tenantId, clientId, active: true };
    const before = await tx.clientContact.findFirst({
      where,
      select: { accessibleDisplay: true },
    });
    if (!before) throw new ActionError('Kontaktprofil nicht gefunden oder deaktiviert.');
    if (before.accessibleDisplay === enabled) return;

    const updated = await tx.clientContact.updateMany({
      where,
      data: { accessibleDisplay: enabled },
    });
    if (updated.count !== 1) {
      throw new ActionError('Kontaktprofil nicht gefunden oder deaktiviert.');
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: contactId,
      action: 'portal.accessible_display.change',
      resourceType: 'client_contact',
      resourceId: contactId,
      before: { accessibleDisplay: before.accessibleDisplay },
      after: { accessibleDisplay: enabled },
    });
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? 'Die Anzeigeeinstellung konnte nicht gespeichert werden.',
    };
  }
  revalidatePath('/portal', 'layout');
  return { ok: true };
}
