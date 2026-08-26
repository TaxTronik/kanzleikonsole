import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260827090000_remove_state_machine_builder/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

describe('State-Builder-Entfernung', () => {
  it('entfernt zuerst die abhängigen Tabellen und danach den Builder', () => {
    const transition = migration.indexOf('DROP TABLE "state_machine_transition"');
    const state = migration.indexOf('DROP TABLE "state_machine_state"');
    const machine = migration.indexOf('DROP TABLE "state_machine"');

    expect(transition).toBeGreaterThanOrEqual(0);
    expect(state).toBeGreaterThan(transition);
    expect(machine).toBeGreaterThan(state);
  });

  it('lässt keine State-Builder-Modelle im Prisma-Schema zurück', () => {
    expect(schema).not.toMatch(/model StateMachine(?:State|Transition)?\s*\{/);
    expect(schema).not.toContain('stateMachines');
  });
});
