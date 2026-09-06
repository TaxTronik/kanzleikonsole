// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: WORKFLOW-DEPENDENCY-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: VDB-PREPARATION-001
import { describe, it, expect } from 'vitest';
import {
  StructureSchema,
  structureHash,
  wouldCreateDependencyCycle,
  dependencyReady,
  parseEndDate,
  vdbTransitionAllowed,
  type StructureInput,
} from '../model';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const structure: StructureInput = {
  clientId: a,
  expectedRevision: 0,
  note: '',
  nodes: [
    { key: a, kind: 'CLIENT', label: 'A', linkedClientId: a, x: 10, y: 20 },
    { key: b, kind: 'PERSON', label: 'B', linkedClientId: null, x: 200, y: 20 },
  ],
  edges: [{ from: b, to: a, kind: 'CAPITAL', percentage: 25, note: '' }],
};
describe('MANDATE-STRUCTURE-001 explicit structures', () => {
  it('accepts direct percentages without inventing indirect control', () =>
    expect(StructureSchema.parse(structure).edges[0]!.percentage).toBe(25));
  it('rejects forged endpoints, duplicate persons and missing mandate references', () => {
    expect(
      StructureSchema.safeParse({
        ...structure,
        edges: [{ ...structure.edges[0], from: '33333333-3333-4333-8333-333333333333' }],
      }).success,
    ).toBe(false);
    expect(
      StructureSchema.safeParse({ ...structure, nodes: [structure.nodes[0], structure.nodes[0]] })
        .success,
    ).toBe(false);
    expect(
      StructureSchema.safeParse({
        ...structure,
        nodes: [{ ...structure.nodes[0], linkedClientId: null }, structure.nodes[1]],
      }).success,
    ).toBe(false);
  });
  it('rejects unsafe ranges and preserves distinguishable share types', () => {
    expect(
      StructureSchema.safeParse({
        ...structure,
        edges: [{ ...structure.edges[0], percentage: 101 }],
      }).success,
    ).toBe(false);
    expect(
      StructureSchema.safeParse({
        ...structure,
        edges: [structure.edges[0], { ...structure.edges[0], kind: 'VOTING' }],
      }).success,
    ).toBe(true);
  });
  it('hashes content independently of record order and changes for different evidence', () => {
    expect(structureHash({ ...structure, nodes: [...structure.nodes].reverse() })).toBe(
      structureHash(structure),
    );
    expect(structureHash({ ...structure, note: 'New source' })).not.toBe(structureHash(structure));
  });
});
describe('WORKFLOW-DEPENDENCY-001 cycles and readiness', () => {
  it('rejects indirect cycles while allowing shared prerequisites', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(wouldCreateDependencyCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCreateDependencyCycle(edges, 'a', 'd')).toBe(false);
    expect(wouldCreateDependencyCycle(edges, 'a', 'a')).toBe(true);
  });
  it('does not declare a target ready for zero, open, cancelled or paused prerequisites', () => {
    expect(dependencyReady([])).toBe(false);
    for (const instanceStatus of ['CANCELLED', 'PAUSED'])
      expect(dependencyReady([{ doneAt: new Date(), instanceStatus }])).toBe(false);
    expect(dependencyReady([{ doneAt: null, instanceStatus: 'ACTIVE' }])).toBe(false);
    expect(dependencyReady([{ doneAt: new Date(), instanceStatus: 'COMPLETED' }])).toBe(true);
  });
});
describe('CLIENT-OFFBOARDING-001 actual mandate end', () => {
  it('accepts a historical date without rolling invalid dates into the next month', () => {
    expect(parseEndDate('2026-02-28', new Date('2026-08-31Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(() => parseEndDate('2026-02-30')).toThrow();
    expect(() => parseEndDate('2026-09-01', new Date('2026-08-31Z'))).toThrow();
  });
});
describe('VDB-PREPARATION-001 independent external evidence', () => {
  it('does not equate signing or preparation with authority confirmation', () => {
    expect(vdbTransitionAllowed(null, 'CONFIRMED')).toBe(false);
    expect(vdbTransitionAllowed('PREPARED', 'CONFIRMED')).toBe(false);
    expect(vdbTransitionAllowed('REPORTED', 'CONFIRMED')).toBe(true);
    expect(vdbTransitionAllowed('SIGNED', 'REPORTED')).toBe(false);
  });
  it('requires renewed preparation after rejection or withdrawal', () => {
    expect(vdbTransitionAllowed('REJECTED', 'REPORTED')).toBe(false);
    expect(vdbTransitionAllowed('REJECTED', 'PREPARED')).toBe(true);
    expect(vdbTransitionAllowed('WITHDRAWN', 'PREPARED')).toBe(true);
  });
});
