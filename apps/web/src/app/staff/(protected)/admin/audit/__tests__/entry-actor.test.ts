import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../[id]/page.tsx', import.meta.url), 'utf8');

describe('audit entry actor', () => {
  it('resolves staff names and shows the complete actor id', () => {
    expect(pageSource).toContain('select: { fullName: true }');
    expect(pageSource).toContain('{staffActor.fullName}');
    expect(pageSource).toContain('{entry.actorId}');
    expect(pageSource).not.toContain('entry.actorId.slice(');
    expect(pageSource).toContain('block break-all font-mono');
  });
});
