// =============================================================================
// Property-Based Tests für das Zugriffsmodell (decideClientAccess).
//
// Statt Beispiele zu testen, werden INVARIANTEN geprüft — für ALLE möglichen
// Kombinationen von isAdmin / mode / vertraulich / isResponsible.
//
// Die wichtigste Invariante (§203 StGB Mandantentrennung):
//   Ein Nicht-Admin ohne ausdrückliche Zuordnung darf NIEMALS auf
//   vertrauliche oder RESTRICTED-Mandanten zugreifen.
// =============================================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { decideClientAccess, type ClientAccessMode } from '../access-policy';

const accessInputArb = fc.record({
  isAdmin: fc.boolean(),
  mode: fc.constantFrom<ClientAccessMode>('OPEN', 'RESTRICTED'),
  vertraulich: fc.boolean(),
  isResponsible: fc.boolean(),
});

describe('decideClientAccess — Property-Based', () => {
  // I1: Admin geht immer durch — egal welche Kombination sonstiger Parameter.
  it('Admin hat immer Zugriff (isAdmin → true)', () => {
    fc.assert(
      fc.property(
        fc.record({
          isAdmin: fc.constant(true),
          mode: fc.constantFrom<ClientAccessMode>('OPEN', 'RESTRICTED'),
          vertraulich: fc.boolean(),
          isResponsible: fc.boolean(),
        }),
        (input) => {
          expect(decideClientAccess(input)).toBe(true);
        },
      ),
    );
  });

  // I2: OPEN + nicht vertraulich → Zugriff für jeden Mitarbeiter (Kanzleikultur).
  it('OPEN + nicht vertraulich → immer Zugriff', () => {
    fc.assert(
      fc.property(
        fc.record({
          isAdmin: fc.boolean(),
          mode: fc.constant<ClientAccessMode>('OPEN'),
          vertraulich: fc.constant(false),
          isResponsible: fc.boolean(),
        }),
        (input) => {
          expect(decideClientAccess(input)).toBe(true);
        },
      ),
    );
  });

  // I3 — §203 StGB Mandantentrennung: Nicht-Admin ohne Zuordnung darf NIEMALS
  // auf vertrauliche oder RESTRICTED-Mandanten zugreifen.
  it('Nicht-Admin ohne Zuordnung → kein Zugriff auf vertraulich/RESTRICTED (§203 StGB)', () => {
    fc.assert(
      fc.property(
        fc.record({
          isAdmin: fc.constant(false),
          mode: fc.constantFrom<ClientAccessMode>('OPEN', 'RESTRICTED'),
          vertraulich: fc.boolean(),
          isResponsible: fc.constant(false),
        }),
        (input) => {
          // OPEN + nicht vertraulich ist der einzige Fall, in dem ein
          // Nicht-Admin ohne Zuordnung Zugriff hat → von I2 abgedeckt.
          fc.pre(!(input.mode === 'OPEN' && !input.vertraulich));
          expect(decideClientAccess(input)).toBe(false);
        },
      ),
    );
  });

  // I4: RESTRICTED-Modus — nur Admin oder zugeordnete Mitarbeiter.
  it('RESTRICTED → nur Admin oder isResponsible', () => {
    fc.assert(
      fc.property(accessInputArb, (input) => {
        fc.pre(input.mode === 'RESTRICTED');
        const result = decideClientAccess(input);
        expect(result).toBe(input.isAdmin || input.isResponsible);
      }),
    );
  });

  // I5: vertraulich wirkt wie ein Minimum-Filter — ohne Admin oder Zuordnung
  // ist der Zugriff blockiert, unabhängig vom mode.
  it('vertraulich + Nicht-Admin → nur mit isResponsible', () => {
    fc.assert(
      fc.property(accessInputArb, (input) => {
        fc.pre(!input.isAdmin && input.vertraulich);
        expect(decideClientAccess(input)).toBe(input.isResponsible);
      }),
    );
  });

  // I6: Monotonie — wenn Zugriff mit gegebenem Satz gewährt wird, dann auch
  // mit mehr Privilegien (isAdmin=true oder isResponsible=true).
  it('Monotonie: mehr Privilegien entziehen niemals Zugriff', () => {
    fc.assert(
      fc.property(accessInputArb, (input) => {
        const base = decideClientAccess(input);
        if (base) {
          expect(decideClientAccess({ ...input, isAdmin: true })).toBe(true);
          expect(decideClientAccess({ ...input, isResponsible: true })).toBe(true);
        }
      }),
    );
  });
});
