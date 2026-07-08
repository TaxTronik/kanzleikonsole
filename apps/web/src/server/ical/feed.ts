// =============================================================================
// ICS-Kalender-Feed fürs Mandanten-Portal (read-only, signiert).
//
// Kalender-Apps (Outlook, Apple, Google) können sich nicht einloggen — der
// Zugriff läuft daher über einen unguessbaren, HMAC-signierten Token in der
// URL (Capability, wie Magic-Link/PoA). Der Token enthält contactId + eine
// pro-Kontakt rotierbare Versionsnummer (clientContact.icalTokenVersion,
// Audit 2026-06 Befund 3) und eine HMAC-Signatur mit domain-getrenntem
// Schlüssel (HKDF aus AUTH_SECRET). Die Route vergleicht die Token-Version
// mit dem DB-Stand: Version inkrementieren = Einzelwiderruf aller Feed-URLs
// dieses Kontakts, ohne globale AUTH_SECRET-Rotation.
// =============================================================================

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@taxtronik/config';

function icalKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.AUTH_SECRET,
      Buffer.from('taxtronik-ical-salt', 'utf8'),
      Buffer.from('taxtronik-ical-token-v1', 'utf8'),
      32,
    ),
  );
}

/**
 * `<contactId>.<version>.<hmac-base64url>` — contactId ist eine UUID, version
 * eine positive Ganzzahl (beide ohne Punkt). Die Version ist Teil des
 * HMAC-Payloads UND klartextlich im Token, damit die Route sie gegen den
 * DB-Stand (clientContact.icalTokenVersion) vergleichen kann.
 */
export function signIcalToken(contactId: string, version: number): string {
  const payload = `${contactId}.${version}`;
  const sig = createHmac('sha256', icalKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Gibt contactId + Version zurück, wenn der Token gültig signiert ist — sonst
 * null. Tokens im alten zweiteiligen Format (vor iter84, ohne Version) sind
 * bewusst ungültig: damit gilt der Versions-Check ausnahmslos.
 */
export function verifyIcalToken(token: string): { contactId: string; version: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [contactId, versionStr, provided] = parts as [string, string, string];
  if (!contactId || !/^\d{1,9}$/.test(versionStr)) return null;
  const expected = createHmac('sha256', icalKey())
    .update(`${contactId}.${versionStr}`)
    .digest('base64url');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { contactId, version: Number(versionStr) };
}

export interface IcalEvent {
  uid: string;
  start: Date;
  end?: Date | null;
  allDay: boolean;
  summary: string;
  description?: string | null;
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateOnly(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function dateTimeUtc(d: Date): string {
  return `${dateOnly(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// RFC 5545 §3.1: Zeilen dürfen max. 75 OKTETTE lang sein (Fortsetzungszeilen
// mit CRLF + Leerzeichen). Wichtig: gemessen in UTF-8-Bytes, nicht in JS-
// String-Längen — Umlaute (2 B) / Emoji (4 B) sprengen sonst das Limit, und ein
// Umbruch mitten in einer Multibyte-Sequenz (Surrogatpaar) erzeugt ungültiges
// UTF-8, das strikte Parser ablehnen. Wir brechen daher an Code-Point-Grenzen
// so, dass jede Zeile inkl. Leerzeichen-Prefix ≤ 75 Oktette bleibt.
const ICS_MAX_OCTETS = 75;

export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= ICS_MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let currentOctets = 0;
  let limit = ICS_MAX_OCTETS; // erste Zeile ohne Leerzeichen-Prefix
  // for..of iteriert über Code Points → Surrogatpaare bleiben intakt.
  for (const cp of line) {
    const cpOctets = Buffer.byteLength(cp, 'utf8');
    if (currentOctets + cpOctets > limit) {
      parts.push(current);
      current = cp;
      currentOctets = cpOctets;
      limit = ICS_MAX_OCTETS - 1; // Fortsetzungszeilen tragen ein führendes ' '
    } else {
      current += cp;
      currentOctets += cpOctets;
    }
  }
  parts.push(current);
  return parts.map((p, i) => (i === 0 ? p : ' ' + p)).join('\r\n');
}

export function buildIcs(calName: string, events: IcalEvent[]): string {
  const now = dateTimeUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//taxtronik//Portal-Kalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}@taxtronik`);
    lines.push(`DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(ev.start)}`);
      // DTEND ist exklusiv → Folgetag für eintägige Termine.
      const end = ev.end ?? new Date(ev.start.getTime() + 24 * 60 * 60 * 1000);
      lines.push(`DTEND;VALUE=DATE:${dateOnly(end)}`);
    } else {
      lines.push(`DTSTART:${dateTimeUtc(ev.start)}`);
      if (ev.end) lines.push(`DTEND:${dateTimeUtc(ev.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
