// =============================================================================
// Re-Export aus @taxtronik/db (Muster M-7, secret-box.ts).
//
// Vorher: eigener Owner-Client hier plus ein zweiter in @taxtronik/db
// (owner-client.ts) — seit @taxtronik/mail den Paket-Client nutzt, hätte der
// Web-Prozess sonst ZWEI Owner-Connection-Pools. Jetzt eine Quelle; der
// Paket-Client cached in Dev ebenfalls über globalThis (HMR-fest).
//
// `Owner` heißt: BYPASSRLS — direkter DB-Zugriff ohne Tenant-Kontext.
// Für mandantenbezogene Reads/Writes immer `withTenantContext` verwenden.
// =============================================================================

export { prismaOwner } from '@taxtronik/db';
