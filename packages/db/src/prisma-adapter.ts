import { PrismaPg } from '@prisma/adapter-pg';

const PLACEHOLDER_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';

export function requireDatabaseUrl(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required to create a Prisma PostgreSQL adapter.`);
  }
  return value;
}

export function optionalDatabaseUrl(value: string | undefined): string {
  return value ?? PLACEHOLDER_DATABASE_URL;
}

export function createPostgresAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({ connectionString });
}
