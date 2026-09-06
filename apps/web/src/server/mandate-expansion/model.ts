import { createHash } from 'node:crypto';
import { z } from 'zod';

export const StructureSchema = z
  .object({
    clientId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    note: z.string().trim().max(3000),
    nodes: z
      .array(
        z
          .object({
            key: z.string().uuid(),
            kind: z.enum(['CLIENT', 'PERSON', 'ORGANIZATION']),
            label: z.string().trim().min(1).max(160),
            linkedClientId: z.string().uuid().nullable(),
            x: z.number().min(0).max(900),
            y: z.number().min(0).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    edges: z
      .array(
        z
          .object({
            from: z.string().uuid(),
            to: z.string().uuid(),
            kind: z.enum(['CAPITAL', 'VOTING', 'CONTROL']),
            percentage: z.number().min(0).max(100).nullable(),
            note: z.string().trim().max(500),
          })
          .strict(),
      )
      .max(90),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = new Set(data.nodes.map((n) => n.key));
    if (ids.size !== data.nodes.length)
      ctx.addIssue({ code: 'custom', message: 'Knotenkennungen müssen eindeutig sein.' });
    const linked = data.nodes.flatMap((n) => (n.linkedClientId ? [n.linkedClientId] : []));
    if (new Set(linked).size !== linked.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Ein Mandant darf je Struktur nur einmal verknüpft sein.',
      });
    if (!linked.includes(data.clientId))
      ctx.addIssue({ code: 'custom', message: 'Der Ausgangsmandant muss Teil der Struktur sein.' });
    for (const node of data.nodes)
      if ((node.kind === 'CLIENT') !== Boolean(node.linkedClientId))
        ctx.addIssue({
          code: 'custom',
          message: 'Mandantenknoten benötigen eine ausdrückliche Mandantenreferenz.',
        });
    const pairs = new Set<string>();
    for (const edge of data.edges) {
      const pair = `${edge.from}:${edge.to}:${edge.kind}`;
      if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || pairs.has(pair))
        ctx.addIssue({
          code: 'custom',
          message:
            'Verbindung benötigt zwei verschiedene vorhandene Knoten und darf nicht doppelt sein.',
        });
      pairs.add(pair);
    }
  });
export type StructureInput = z.infer<typeof StructureSchema>;
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function structureHash(input: StructureInput): string {
  return contentHash({
    clientId: input.clientId,
    note: input.note,
    nodes: [...input.nodes].sort((a, b) => a.key.localeCompare(b.key)),
    edges: [...input.edges].sort((a, b) =>
      `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`),
    ),
  });
}
export function wouldCreateDependencyCycle(
  edges: readonly { from: string; to: string }[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const visited = new Set<string>();
  const pending = [to];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === from) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of edges) if (e.from === id) pending.push(e.to);
  }
  return false;
}
export function dependencyReady(
  predecessors: readonly { doneAt: Date | null; instanceStatus: string }[],
): boolean {
  return (
    predecessors.length > 0 &&
    predecessors.every(
      (p) => p.doneAt !== null && p.instanceStatus !== 'CANCELLED' && p.instanceStatus !== 'PAUSED',
    )
  );
}
export function parseEndDate(value: string, now = new Date()): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Ein gültiges Mandatsende angeben.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    value > now.toISOString().slice(0, 10)
  )
    throw new Error('Mandatsende muss ein bestehendes Datum bis heute sein.');
  return date;
}
export const VDB_STATES = ['PREPARED', 'REPORTED', 'CONFIRMED', 'REJECTED', 'WITHDRAWN'] as const;
export const VDB_LABELS: Record<string, string> = {
  PREPARED: 'Vorbereitet',
  REPORTED: 'Extern gemeldet',
  CONFIRMED: 'Bestätigung dokumentiert',
  REJECTED: 'Zurückgewiesen',
  WITHDRAWN: 'Rücknahme dokumentiert',
};
export function vdbTransitionAllowed(previous: string | null, next: string): boolean {
  const transitions: Record<string, readonly string[]> = {
    NONE: ['PREPARED'],
    PREPARED: ['REPORTED', 'WITHDRAWN'],
    REPORTED: ['CONFIRMED', 'REJECTED', 'WITHDRAWN'],
    REJECTED: ['PREPARED', 'WITHDRAWN'],
    CONFIRMED: ['WITHDRAWN'],
    WITHDRAWN: ['PREPARED'],
  };
  return transitions[previous ?? 'NONE']?.includes(next) ?? false;
}
