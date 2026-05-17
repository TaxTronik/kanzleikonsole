// =============================================================================
// Owner-PrismaClient als Worker-globaler Singleton (M6)
//
// Vorher: jeder Job hatte sein eigenes `new PrismaClient(...)`. Mit 11 Jobs
// = 11 Connection-Pools im Worker-Prozess. Verschwendet RAM + Postgres-Slots.
//
// Pendant zu apps/web/src/server/db/prisma-owner.ts. Im Worker brauchen wir
// kein HMR-Caching — der Worker-Prozess hat keine Hot-Reload-Semantik wie
// Next.js dev.
// =============================================================================

import { PrismaClient } from '@prisma/client';

export const prismaOwner = new PrismaClient({
  datasourceUrl: process.env['DATABASE_URL'],
});
