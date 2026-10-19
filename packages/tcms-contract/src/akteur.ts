// =============================================================================
// Akteursbestätigung der kanzleikonsole (ADR 0001, Abschnitt 3.2).
//
// Die kanzleikonsole signiert je Anfrage ein kurzlebiges Ed25519-Token; der
// Dienst prüft es und leitet daraus den Akteur ab. Dieses Modul ist der
// gemeinsame Vertrag beider Seiten: Claims-Schema (strikt) und Akteurstyp.
// Signieren und Prüfen (node:crypto) liegen in `signatur.ts`, damit beide
// Seiten denselben Code nutzen.
// =============================================================================

import { z } from 'zod';

export const AKTEUR_HEADER = 'x-tcms-akteur';
export const AKTEUR_TYP = 'tcms-akteur+jwt';
export const AKTEUR_ISSUER = 'kanzleikonsole';
export const AKTEUR_AUDIENCE = 'tcms';
/** Höchste Lebensdauer einer Bestätigung (exp - iat) in Sekunden. */
export const AKTEUR_MAX_LEBENSDAUER_S = 120;
/** Erlaubte Abweichung von iat in die Zukunft, in Sekunden. */
export const AKTEUR_MAX_VORLAUF_S = 30;
/** Höchste Größe des kompakten Tokens in Bytes. */
export const AKTEUR_MAX_BYTES = 4096;

/**
 * Akteursarten (ADR 0001 §3.2): Kanzleiperson, Mandantenkontakt und
 * Systemakteur. Der Systemakteur ist keine Person, sondern ein Dienstnutzer
 * der kanzleikonsole je Tenant (z. B. der Worker, der Nachrichten zustellt);
 * er hat weder Rollen noch Mandantenbezug und erreicht nur Endpunkte, die ihn
 * im Endpunktregister ausdrücklich zulassen (`akteure`, ADR 0001 §7).
 */
export const AKTEUR_ARTEN = ['KANZLEI', 'MANDANT', 'SYSTEM'] as const;
export type AkteurArt = (typeof AKTEUR_ARTEN)[number];

const uuid = z.uuid();
const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

export const AkteurHeaderSchema = z
  .object({
    alg: z.literal('EdDSA'),
    typ: z.literal(AKTEUR_TYP),
    kid: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
  })
  .strict();

export const AnfrageBindungSchema = z
  .object({
    /** HTTP-Methode in Großbuchstaben. */
    m: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** Pfad inklusive Query, wie der Dienst ihn empfängt (z. B. `/v1/mandanten/…?stand=2026-10-16`). */
    p: z.string().min(1).max(2048).startsWith('/'),
    /** base64url(SHA-256(Body)); bei leerem Body der Hash des leeren Strings. */
    b: base64url(43, 43),
  })
  .strict();

export const AkteurClaimsSchema = z
  .object({
    iss: z.literal(AKTEUR_ISSUER),
    aud: z.literal(AKTEUR_AUDIENCE),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    jti: base64url(22, 64),
    tnt: uuid,
    sub: uuid,
    knd: z.enum(AKTEUR_ARTEN),
    nam: z.string().trim().min(1).max(200),
    rol: z.object({ adm: z.boolean(), bt: z.boolean() }).strict().optional(),
    cli: z.object({ id: uuid, bt: z.boolean(), hb: z.boolean() }).strict().optional(),
    req: AnfrageBindungSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.knd === 'KANZLEI' && !c.rol) {
      ctx.addIssue({ code: 'custom', path: ['rol'], message: 'rol ist für KANZLEI Pflicht' });
    }
    if (c.knd === 'MANDANT') {
      if (c.rol) ctx.addIssue({ code: 'custom', path: ['rol'], message: 'rol nur für KANZLEI' });
      if (!c.cli)
        ctx.addIssue({ code: 'custom', path: ['cli'], message: 'cli ist für MANDANT Pflicht' });
      else if (c.cli.bt || c.cli.hb) {
        ctx.addIssue({ code: 'custom', path: ['cli'], message: 'bt/hb nur für KANZLEI' });
      }
    }
    // Systemakteur: weder Rollen noch Mandantenbezug. Ein Systemakteur mit `rol`
    // oder `cli` wäre eine verdeckte Person bzw. bekäme Mandantenpfade (fail closed).
    if (c.knd === 'SYSTEM') {
      if (c.rol) ctx.addIssue({ code: 'custom', path: ['rol'], message: 'rol nur für KANZLEI' });
      if (c.cli) ctx.addIssue({ code: 'custom', path: ['cli'], message: 'cli nicht für SYSTEM' });
    }
    if (c.exp <= c.iat) ctx.addIssue({ code: 'custom', path: ['exp'], message: 'exp ≤ iat' });
    if (c.exp - c.iat > AKTEUR_MAX_LEBENSDAUER_S) {
      ctx.addIssue({ code: 'custom', path: ['exp'], message: 'Lebensdauer zu lang' });
    }
  });

export type AkteurClaims = z.infer<typeof AkteurClaimsSchema>;

/** Mandantenbezug einer Kanzleiperson, von der kanzleikonsole bestätigt. */
export interface MandantBezug {
  id: string;
  /** zuständige:r Berufsträger:in dieses Mandanten */
  zustaendigBerufstraeger: boolean;
  /** Hauptbearbeitung dieses Mandanten */
  hauptbearbeitung: boolean;
}

/** Kanzleiperson (Mitarbeiter-ID der kanzleikonsole). */
export interface KanzleiAkteur {
  art: 'KANZLEI';
  tenantId: string;
  id: string;
  name: string;
  istAdmin: boolean;
  istBerufstraeger: boolean;
  mandant: MandantBezug | null;
}

/**
 * Mandantenkontakt (Kontakt-ID der kanzleikonsole). Rollen der Mandantenseite
 * (GV, TCB, Mitarbeiter) stehen nicht hier, sondern im Tax-CMS
 * (MandantKontaktRolle) und werden vom Dienst nachgeladen.
 */
export interface MandantAkteur {
  art: 'MANDANT';
  tenantId: string;
  id: string;
  name: string;
  mandantId: string;
}

/**
 * Systemakteur: Dienstnutzer der kanzleikonsole (`sub` = feste ID je Tenant,
 * `nam` = Bezeichnung für das Audit). Keine Person, keine Rollen, kein
 * Mandantenbezug; Fachoperationen für Personen lehnen ihn ab (ADR 0001 §3.2).
 */
export interface SystemAkteur {
  art: 'SYSTEM';
  tenantId: string;
  id: string;
  name: string;
}

/** Handelnde Person (Kanzleiperson oder Mandantenkontakt). */
export type PersonAkteur = KanzleiAkteur | MandantAkteur;

/** Akteur einer Anfrage, abgeleitet aus geprüften Claims. */
export type Akteur = PersonAkteur | SystemAkteur;

export function akteurAusClaims(c: AkteurClaims): Akteur {
  switch (c.knd) {
    case 'KANZLEI':
      return {
        art: 'KANZLEI',
        tenantId: c.tnt,
        id: c.sub,
        name: c.nam,
        istAdmin: c.rol!.adm,
        istBerufstraeger: c.rol!.bt,
        mandant: c.cli
          ? { id: c.cli.id, zustaendigBerufstraeger: c.cli.bt, hauptbearbeitung: c.cli.hb }
          : null,
      };
    case 'MANDANT':
      return { art: 'MANDANT', tenantId: c.tnt, id: c.sub, name: c.nam, mandantId: c.cli!.id };
    case 'SYSTEM':
      return { art: 'SYSTEM', tenantId: c.tnt, id: c.sub, name: c.nam };
    default:
      // Unerreichbar mit geprüften Claims; fail closed statt einer Standardart.
      throw new Error('Akteursbestätigung: unbekannte Akteursart');
  }
}
