// =============================================================================
// Einmal-Ticket zwischen Passwortschritt und zweitem Schritt der Staff-
// Anmeldung (R-04)
//
// Nach erfolgreicher Passwortprüfung stellt der Server ein zufälliges
// 256-Bit-Ticket aus. Redis speichert unter dem SHA-256 des Tickets (nie das
// Ticket selbst) die Bindung an Konto, Tenant, `authRevision`, den geprüften
// Passwort-Hash (als SHA-256) und den Zweck; nach fünf Minuten verfällt es.
// Der zweite Schritt (TOTP/Backup-Code, Erst-Enrollment, lokaler DEV-Pfad)
// verbraucht das Ticket atomar mit GETDEL, statt das Passwort erneut zu
// prüfen. Ein zweiter Einsatz, eine inzwischen geänderte Revision, ein
// geändertes Passwort oder ein anderer Zweck scheitern. Ohne Redis gibt es
// weder Ausstellung noch Einlösung (fail-closed).
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const STAFF_LOGIN_TICKET_TTL_SECONDS = 5 * 60;

// randomBytes(32) als base64url: genau 43 Zeichen.
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `second-factor`: TOTP/Backup-Code bzw. DEV-Login; `totp-enrollment`: Erst-Setup. */
export type StaffLoginTicketPurpose = 'second-factor' | 'totp-enrollment';

/** Der im Passwortschritt bewiesene Kontostand. */
export interface StaffLoginTicketAccount {
  id: string;
  tenantId: string;
  authRevision: number;
  passwordHash: string;
}

interface StoredTicket {
  v: 1;
  purpose: StaffLoginTicketPurpose;
  staffId: string;
  tenantId: string;
  authRevision: number;
  passwordHashDigest: string;
}

export class StaffLoginTicketUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Anmeldeticket kann nicht gespeichert werden.', options);
    this.name = 'StaffLoginTicketUnavailableError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ticketKey(ticket: string): string {
  return `staff-login-ticket:${sha256(ticket)}`;
}

function isStoredTicket(value: unknown): value is StoredTicket {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    (o['purpose'] === 'second-factor' || o['purpose'] === 'totp-enrollment') &&
    typeof o['staffId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    typeof o['authRevision'] === 'number' &&
    Number.isSafeInteger(o['authRevision']) &&
    typeof o['passwordHashDigest'] === 'string'
  );
}

/** Stellt ein Ticket für genau diesen Kontostand aus; wirft ohne Redis. */
export async function issueStaffLoginTicket(
  purpose: StaffLoginTicketPurpose,
  account: StaffLoginTicketAccount,
): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new StaffLoginTicketUnavailableError();
  const ticket = randomBytes(32).toString('base64url');
  const stored: StoredTicket = {
    v: 1,
    purpose,
    staffId: account.id,
    tenantId: account.tenantId,
    authRevision: account.authRevision,
    passwordHashDigest: sha256(account.passwordHash),
  };
  try {
    const result = await redis.set(
      ticketKey(ticket),
      JSON.stringify(stored),
      'EX',
      STAFF_LOGIN_TICKET_TTL_SECONDS,
      'NX',
    );
    if (result !== 'OK') throw new Error('ticket collision');
  } catch (error) {
    throw new StaffLoginTicketUnavailableError({ cause: error });
  }
  return ticket;
}

/**
 * Verbraucht ein Ticket genau einmal. null bei unbekanntem, abgelaufenem,
 * bereits verbrauchtem oder für einen anderen Zweck ausgestelltem Ticket und
 * bei Redis-Fehlern; auch dann ist das Ticket danach verbraucht.
 */
export async function consumeStaffLoginTicket(
  ticket: unknown,
  purpose: StaffLoginTicketPurpose,
): Promise<Omit<StoredTicket, 'v'> | null> {
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return null;
  const redis = getRedis();
  if (!redis) return null;
  let raw: string | null;
  try {
    raw = await redis.getdel(ticketKey(ticket));
  } catch (error) {
    log.warn(
      { component: 'staff-login-ticket', err: (error as Error).message },
      'Anmeldeticket konnte nicht eingelöst werden',
    );
    return null;
  }
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredTicket(stored) || stored.purpose !== purpose) return null;
  return {
    purpose: stored.purpose,
    staffId: stored.staffId,
    tenantId: stored.tenantId,
    authRevision: stored.authRevision,
    passwordHashDigest: stored.passwordHashDigest,
  };
}

/** Entspricht das Konto noch exakt dem im Passwortschritt geprüften Stand? */
export function staffLoginTicketMatches(
  binding: Omit<StoredTicket, 'v'>,
  account: StaffLoginTicketAccount,
): boolean {
  return (
    binding.staffId === account.id &&
    binding.tenantId === account.tenantId &&
    binding.authRevision === account.authRevision &&
    binding.passwordHashDigest === sha256(account.passwordHash)
  );
}
