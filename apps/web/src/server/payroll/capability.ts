import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { withTenantContext, type TxClient } from '@taxtronik/db/tenant-context';
import { checkIpOrGlobalLimit, getClientIp, checkRateLimit } from '@/server/rate-limit';
import { ActionError } from '@/server/actions/action-error';
import type { PayrollField } from './definition';
export const PAYROLL_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Secure-payroll-employee' : 'payroll-employee';
export const EMPTY_PAYROLL_CONTEXT = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  actorId: null,
  actorType: 'STAFF' as const,
};
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function newPayrollToken(): string {
  return randomBytes(32).toString('hex');
}
export type GuestIntake = {
  id: string;
  tenantId: string;
  revision: number;
  status: string;
  label: string;
  schema: PayrollField[];
  answers: Record<string, string>;
  submitted: boolean;
  expiresAt: string;
  reviewNote: string | null;
  attachments: Array<{ id: string; filename: string; status: string }>;
};
export async function withPayrollCapability<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return withTenantContext(EMPTY_PAYROLL_CONTEXT, fn);
}
export async function guestHash(): Promise<string | null> {
  const token = (await cookies()).get(PAYROLL_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return tokenHash(token);
}
export async function guestRead(): Promise<GuestIntake | null> {
  const hash = await guestHash();
  if (!hash) return null;
  return withPayrollCapability(
    async (tx) =>
      (
        await tx.$queryRaw<
          Array<{ data: GuestIntake | null }>
        >`SELECT app.payroll_guest_read(${hash}) AS data`
      )[0]?.data ?? null,
  );
}
export async function requireGuestHash(): Promise<string> {
  const hash = await guestHash();
  if (!hash)
    throw new ActionError(
      'Zugang abgelaufen. Neuen Link beim Arbeitgeber oder bei der Kanzlei anfordern.',
    );
  if (!(await checkRateLimit('payroll-guest:' + hash, { max: 60, windowSec: 600 })).ok)
    throw new ActionError('Zu viele Aktionen. Bitte später erneut versuchen.');
  return hash;
}
export async function guardPayrollEmployeeEntry(raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return false;
  const ip = getClientIp(await headers());
  if (
    !(
      await checkIpOrGlobalLimit(
        'payroll-invite',
        ip,
        { max: 10, windowSec: 600 },
        { max: 60, windowSec: 600 },
      )
    ).ok
  )
    return false;
  const token = newPayrollToken();
  const hash = tokenHash(token);
  const invite = tokenHash(raw);
  const expiry = await withPayrollCapability(
    async (tx) =>
      (
        await tx.$queryRaw<
          Array<{ expiry: Date | null }>
        >`SELECT app.payroll_guest_exchange(${invite},${hash}) AS expiry`
      )[0]?.expiry,
  );
  if (!expiry) return false;
  (await cookies()).set(PAYROLL_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/payroll/employee',
    expires: expiry,
  });
  return true;
}

/** Validates the separate cookie against the live invite, mandate, module and expiry in SQL. */
export async function guardPayrollEmployee(): Promise<{ hash: string; item: GuestIntake }> {
  const hash = await requireGuestHash();
  const item = await guestRead();
  if (!item) throw new ActionError('Zugang abgelaufen oder widerrufen.');
  return { hash, item };
}

/** Logout may revoke an expired capability, but can never act on another token. */
export async function guardPayrollEmployeeLogout(): Promise<void> {
  const hash = await guestHash();
  if (hash)
    await withPayrollCapability((tx) => tx.$executeRaw`SELECT app.payroll_guest_logout(${hash})`);
  (await cookies()).delete({ name: PAYROLL_COOKIE, path: '/payroll/employee' });
}
