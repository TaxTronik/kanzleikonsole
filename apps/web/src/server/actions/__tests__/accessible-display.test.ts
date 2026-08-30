import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withStaff: vi.fn(),
    withPortalContext: vi.fn(),
    staffFindFirst: vi.fn(),
    staffUpdateMany: vi.fn(),
    contactFindFirst: vi.fn(),
    contactUpdateMany: vi.fn(),
    evidenceRecord: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: mocks.ActionError,
  withStaff: mocks.withStaff,
}));
vi.mock('@/server/actions/portal-action', () => ({ withPortalContext: mocks.withPortalContext }));

import {
  savePortalAccessibleDisplayAction,
  saveStaffAccessibleDisplayAction,
  saveStaffAccessibleDisplayOptionsAction,
  savePortalAccessibleDisplayOptionsAction,
} from '../accessible-display';
import { DISPLAY_OPTIONS_SELECT, type DisplayOptionsPatch } from '@/lib/accessible-display-options';

const STAFF_CONTEXT = { tenantId: 'tenant-a', staffId: 'staff-a' };
const PORTAL_CONTEXT = { tenantId: 'tenant-a', contactId: 'contact-a', clientId: 'client-a' };
const tx = {
  staffUser: { findFirst: mocks.staffFindFirst, updateMany: mocks.staffUpdateMany },
  clientContact: { findFirst: mocks.contactFindFirst, updateMany: mocks.contactUpdateMany },
};

async function runWrappedAction(
  fn: (transaction: typeof tx, ctx: typeof STAFF_CONTEXT | typeof PORTAL_CONTEXT) => unknown,
  ctx: typeof STAFF_CONTEXT | typeof PORTAL_CONTEXT,
) {
  try {
    await fn(tx, ctx);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof mocks.ActionError ? error.message : 'Datenbankfehler.',
    };
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.staffFindFirst.mockResolvedValue({ accessibleDisplay: false });
  mocks.contactFindFirst.mockResolvedValue({ accessibleDisplay: false });
  mocks.staffUpdateMany.mockResolvedValue({ count: 1 });
  mocks.contactUpdateMany.mockResolvedValue({ count: 1 });
  mocks.withStaff.mockImplementation((fn) => runWrappedAction(fn, STAFF_CONTEXT));
  mocks.withPortalContext.mockImplementation((fn) => runWrappedAction(fn, PORTAL_CONTEXT));
});

const surfaces = [
  {
    name: 'staff',
    profileKey: 'staff:tenant-a:staff-a',
    action: saveStaffAccessibleDisplayAction,
    optionsAction: saveStaffAccessibleDisplayOptionsAction,
    wrapper: mocks.withStaff,
    findFirst: mocks.staffFindFirst,
    updateMany: mocks.staffUpdateMany,
    otherUpdate: mocks.contactUpdateMany,
    where: { id: 'staff-a', tenantId: 'tenant-a', active: true },
    actorType: 'STAFF',
    actorId: 'staff-a',
    resourceType: 'staff_user',
    missingMessage: 'Benutzerkonto nicht gefunden oder deaktiviert.',
  },
  {
    name: 'portal',
    profileKey: 'portal:tenant-a:contact-a',
    action: savePortalAccessibleDisplayAction,
    optionsAction: savePortalAccessibleDisplayOptionsAction,
    wrapper: mocks.withPortalContext,
    findFirst: mocks.contactFindFirst,
    updateMany: mocks.contactUpdateMany,
    otherUpdate: mocks.staffUpdateMany,
    where: { id: 'contact-a', tenantId: 'tenant-a', clientId: 'client-a', active: true },
    actorType: 'CLIENT_CONTACT',
    actorId: 'contact-a',
    resourceType: 'client_contact',
    missingMessage: 'Kontaktprofil nicht gefunden oder deaktiviert.',
  },
] as const;

// ACCESS-TENANT-RLS-001: unveränderter Tenantkontext, zusätzlich eigener Profilscope.
describe.each(surfaces)('$name individual display options — ACCESS-TENANT-RLS-001', (surface) => {
  const save = (patch: DisplayOptionsPatch) => surface.optionsAction(surface.profileKey, patch);

  it.each([
    null,
    undefined,
    true,
    [],
    {},
    { actorId: 'other' },
    { fontSize: 500 },
    { reduceMotion: 'false' },
    { spacing: 'wide', tenantId: 'other' },
  ])('rejects invalid fields before profile access: %j', async (value) => {
    expect(await save(value as unknown as DisplayOptionsPatch)).toEqual({
      ok: false,
      error: 'Ungültige Anzeigeoptionen.',
    });
    expect(surface.wrapper).not.toHaveBeenCalled();
    expect(surface.updateMany).not.toHaveBeenCalled();
  });

  it('patches only requested fields on the authenticated active profile', async () => {
    expect(await save({ fontSize: 'extra-large', reduceMotion: false })).toEqual({ ok: true });
    expect(surface.findFirst).toHaveBeenCalledWith({
      where: surface.where,
      select: DISPLAY_OPTIONS_SELECT,
    });
    expect(surface.updateMany).toHaveBeenCalledWith({
      where: surface.where,
      data: { accessibleDisplayFontSize: 'extra-large', accessibleDisplayReduceMotion: false },
    });
    expect(surface.otherUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: surface.actorId,
        actorType: surface.actorType,
        action: `${surface.name}.accessible_display.options.change`,
        before: { fontSize: 'large', reduceMotion: true },
        after: { fontSize: 'extra-large', reduceMotion: false },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/${surface.name}`, 'layout');
  });

  it('requires authentication and rejects stale forms before any profile lookup', async () => {
    surface.wrapper.mockResolvedValueOnce({ ok: false, error: 'Nicht eingeloggt.' });
    expect(await save({ spacing: 'wide' })).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
    expect(surface.findFirst).not.toHaveBeenCalled();
    expect(await surface.optionsAction('other:profile', { spacing: 'wide' })).toMatchObject({
      ok: false,
    });
    expect(surface.findFirst).not.toHaveBeenCalled();
    expect(surface.updateMany).not.toHaveBeenCalled();
  });

  it('keeps unrelated stored options and avoids duplicate no-op audit entries', async () => {
    surface.findFirst.mockResolvedValue({
      accessibleDisplayFontSize: 'extra-large',
      accessibleDisplaySpacing: 'wide',
      accessibleDisplayContrast: 'standard',
      accessibleDisplayReduceMotion: false,
    });
    expect(await save({ spacing: 'wide' })).toEqual({ ok: true });
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(await save({ fontSize: 'standard' })).toEqual({ ok: true });
    expect(surface.updateMany).toHaveBeenCalledWith({
      where: surface.where,
      data: { accessibleDisplayFontSize: 'standard' },
    });
  });

  it('does not report success for a disappeared/deactivated account', async () => {
    surface.findFirst.mockResolvedValueOnce(null);
    expect(await save({ spacing: 'wide' })).toMatchObject({ ok: false });
    expect(surface.updateMany).not.toHaveBeenCalled();
    surface.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await save({ spacing: 'wide' })).toMatchObject({ ok: false });
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('propagates transaction failure without success or revalidation', async () => {
    mocks.evidenceRecord.mockRejectedValueOnce(new Error('private database detail'));
    expect(await save({ spacing: 'wide' })).toEqual({ ok: false, error: 'Datenbankfehler.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe.each(surfaces)('$name accessible display action', (surface) => {
  const save = (enabled: boolean) => surface.action(surface.profileKey, enabled);

  it.each([undefined, null, 'true', 'false', 0, 1, { enabled: true, actorId: 'forged-id' }])(
    'rejects non-boolean input %j without touching any profile',
    async (value) => {
      expect(await save(value as unknown as boolean)).toEqual({
        ok: false,
        error: 'Ungültige Anzeigeeinstellung.',
      });
      expect(surface.wrapper).not.toHaveBeenCalled();
      expect(surface.updateMany).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('requires the authenticated surface-specific session', async () => {
    surface.wrapper.mockResolvedValueOnce({ ok: false, error: 'Nicht eingeloggt.' });

    expect(await save(true)).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
    expect(surface.findFirst).not.toHaveBeenCalled();
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(surface.otherUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('writes only the active session profile and revalidates its complete protected layout', async () => {
    expect(await save(true)).toEqual({ ok: true });

    expect(surface.wrapper).toHaveBeenCalledWith(expect.any(Function));
    expect(surface.findFirst).toHaveBeenCalledWith({
      where: surface.where,
      select: { accessibleDisplay: true },
    });
    expect(surface.updateMany).toHaveBeenCalledWith({
      where: surface.where,
      data: { accessibleDisplay: true },
    });
    expect(surface.otherUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-a',
      actorType: surface.actorType,
      actorId: surface.actorId,
      action: `${surface.name}.accessible_display.change`,
      resourceType: surface.resourceType,
      resourceId: surface.actorId,
      before: { accessibleDisplay: false },
      after: { accessibleDisplay: true },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(`/${surface.name}`, 'layout');
    expect(surface.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revalidatePath.mock.invocationCallOrder[0]!,
    );
  });

  it('can disable an enabled preference without affecting other account fields', async () => {
    surface.findFirst.mockResolvedValueOnce({ accessibleDisplay: true });

    expect(await save(false)).toEqual({ ok: true });
    expect(surface.updateMany).toHaveBeenCalledWith({
      where: surface.where,
      data: { accessibleDisplay: false },
    });
  });

  it('does not write or duplicate audit events for an unchanged preference', async () => {
    expect(await save(false)).toEqual({ ok: true });
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/${surface.name}`, 'layout');
  });

  it('rejects missing, inactive or out-of-scope profiles', async () => {
    surface.findFirst.mockResolvedValueOnce(null);

    expect(await save(true)).toEqual({ ok: false, error: surface.missingMessage });
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('fails when the account is deactivated between read and write', async () => {
    surface.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await save(true)).toEqual({ ok: false, error: surface.missingMessage });
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not return success or refresh on a failed transaction', async () => {
    surface.updateMany.mockRejectedValueOnce(new Error('private database detail'));

    expect(await save(true)).toEqual({ ok: false, error: 'Datenbankfehler.' });
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not return success or refresh if evidence persistence fails', async () => {
    mocks.evidenceRecord.mockRejectedValueOnce(new Error('private evidence detail'));

    expect(await save(true)).toEqual({ ok: false, error: 'Datenbankfehler.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    '',
    { profileKey: 'forged-id' },
    'staff:tenant-a:another-staff',
    'portal:tenant-a:another-contact',
    'staff:tenant-b:staff-a',
    'portal:tenant-b:contact-a',
    'SYSTEM:tenant-a:staff-a',
  ])('rejects missing, forged or stale profile key %j after authentication', async (key) => {
    expect(await surface.action(key as unknown as string, true)).toEqual({
      ok: false,
      error:
        'Das aktive Benutzerprofil hat sich geändert. Bitte öffnen Sie die Profileinstellungen erneut.',
    });
    expect(surface.wrapper).toHaveBeenCalledWith(expect.any(Function));
    expect(surface.findFirst).not.toHaveBeenCalled();
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(surface.otherUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not apply a stale tab setting to a profile selected in another tab', async () => {
    const nextSession =
      surface.name === 'staff'
        ? { ...STAFF_CONTEXT, staffId: 'staff-b' }
        : { ...PORTAL_CONTEXT, contactId: 'contact-b', clientId: 'client-b' };
    surface.wrapper.mockImplementationOnce((fn) => runWrappedAction(fn, nextSession));

    expect(await save(true)).toEqual({
      ok: false,
      error:
        'Das aktive Benutzerprofil hat sich geändert. Bitte öffnen Sie die Profileinstellungen erneut.',
    });
    expect(surface.findFirst).not.toHaveBeenCalled();
    expect(surface.updateMany).not.toHaveBeenCalled();
    expect(surface.otherUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('accepts a freshly rendered matching key but still derives write IDs from the session', async () => {
    const nextSession =
      surface.name === 'staff'
        ? { ...STAFF_CONTEXT, staffId: 'staff-b' }
        : { ...PORTAL_CONTEXT, contactId: 'contact-b', clientId: 'client-b' };
    const nextActorId = surface.name === 'staff' ? 'staff-b' : 'contact-b';
    surface.wrapper.mockImplementationOnce((fn) => runWrappedAction(fn, nextSession));

    expect(await surface.action(`${surface.name}:tenant-a:${nextActorId}`, true)).toEqual({
      ok: true,
    });
    expect(surface.updateMany).toHaveBeenCalledWith({
      where: {
        id: nextActorId,
        tenantId: 'tenant-a',
        active: true,
        ...(surface.name === 'portal' ? { clientId: 'client-b' } : {}),
      },
      data: { accessibleDisplay: true },
    });
    expect(surface.otherUpdate).not.toHaveBeenCalled();
  });
});
