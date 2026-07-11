import { createHash } from 'node:crypto';

/** Serialisiert und hasht exakt dieselben Download-Bytes. */
export function serializeDsgvoExport(value: unknown): {
  serialized: string;
  sha256: Buffer;
} {
  const serialized = JSON.stringify(value, null, 2);
  return {
    serialized,
    sha256: createHash('sha256').update(serialized, 'utf8').digest(),
  };
}
