// =============================================================================
// Prisma Client runtime interop.
//
// Prisma 7's generated @prisma/client is CommonJS-shaped in our host-side tsx
// scripts. Native ESM named imports such as
//   import { PrismaClient } from '@prisma/client'
// can therefore fail at runtime, while Vitest mocks often expose named exports
// without a default. This adapter accepts both shapes and keeps the workaround
// in one place.
// =============================================================================

import * as prismaClientNamespace from '@prisma/client';

type PrismaClientNamespace = typeof prismaClientNamespace;
type PrismaClientInterop = PrismaClientNamespace & {
  default?: PrismaClientNamespace;
};

const maybeDefault = Object.prototype.hasOwnProperty.call(prismaClientNamespace, 'default')
  ? (prismaClientNamespace as PrismaClientInterop).default
  : undefined;

const prismaClientModule = maybeDefault ?? prismaClientNamespace;

function readPrismaExport<K extends keyof PrismaClientNamespace>(
  key: K,
): PrismaClientNamespace[K] | undefined {
  return Object.prototype.hasOwnProperty.call(prismaClientModule, key)
    ? prismaClientModule[key]
    : undefined;
}

export const PrismaClient = readPrismaExport('PrismaClient') as PrismaClientNamespace['PrismaClient'];
export const Prisma = readPrismaExport('Prisma') as PrismaClientNamespace['Prisma'];
export type PrismaClientInstance = InstanceType<typeof PrismaClient>;
