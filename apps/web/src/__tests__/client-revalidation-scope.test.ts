import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROAD_CLIENT_INVALIDATION = "revalidatePath('/staff/clients', 'layout')";
const ALLOWED = new Set(['app/staff/(protected)/admin/settings/modules-actions.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(entry)
        ? [path]
        : [];
  });
}

describe('client cache invalidation scope', () => {
  it('allows layout-wide client invalidation only for cross-client settings', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes(`${join('src', '__tests__')}`))
      .filter((file) => readFileSync(file, 'utf8').includes(BROAD_CLIENT_INVALIDATION))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))
      .filter((file) => !ALLOWED.has(file));

    expect(
      offenders,
      'Mandantenbezogene Actions müssen /staff/clients/<clientId> gezielt invalidieren.',
    ).toEqual([]);
  });
});
