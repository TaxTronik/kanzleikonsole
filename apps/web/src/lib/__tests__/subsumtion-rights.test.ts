import { describe, expect, it } from 'vitest';
import {
  decideSubsumtionAction,
  decideResultReview,
  type SubsumtionRights,
} from '@/lib/subsumtion-rights';

const VOLL: SubsumtionRights = { canWrite: true, assignedMarkingIds: [] };
const BEARBEITER: SubsumtionRights = { canWrite: false, assignedMarkingIds: ['m1', 'm2'] };
const LESER: SubsumtionRights = { canWrite: false, assignedMarkingIds: [] };

describe('decideSubsumtionAction', () => {
  it('laesst jeden mit Mandantenzugriff lesen', () => {
    for (const r of [VOLL, BEARBEITER, LESER]) {
      expect(decideSubsumtionAction(r, 'lesen')).toBe(true);
    }
  });

  it('erlaubt Schreiben nur der vollen Stufe', () => {
    expect(decideSubsumtionAction(VOLL, 'schreiben')).toBe(true);
    expect(decideSubsumtionAction(BEARBEITER, 'schreiben')).toBe(false);
    expect(decideSubsumtionAction(LESER, 'schreiben')).toBe(false);
  });

  it('erlaubt dem Bearbeiter Recherche nur an SEINER Markierung', () => {
    expect(decideSubsumtionAction(BEARBEITER, 'recherche', 'm1')).toBe(true);
    expect(decideSubsumtionAction(BEARBEITER, 'recherche', 'm2')).toBe(true);
    expect(decideSubsumtionAction(BEARBEITER, 'recherche', 'fremd')).toBe(false);
  });

  it('verweigert Recherche ohne Markierungsbezug', () => {
    // Das waere „ganzer Fall an die KI" — genau die Vollmacht, die hier
    // eingeschraenkt wird. Auch mit zugewiesenen Markierungen nicht erlaubt.
    expect(decideSubsumtionAction(BEARBEITER, 'recherche')).toBe(false);
    expect(decideSubsumtionAction(BEARBEITER, 'recherche', null)).toBe(false);
    expect(decideSubsumtionAction(LESER, 'recherche', 'm1')).toBe(false);
  });

  it('laesst die volle Stufe auch ohne Zuweisung recherchieren', () => {
    expect(decideSubsumtionAction(VOLL, 'recherche')).toBe(true);
    expect(decideSubsumtionAction(VOLL, 'recherche', 'fremd')).toBe(true);
  });
});

describe('decideResultReview', () => {
  it('bindet die Pruefentscheidung ans Ergebnis, nicht an die mitgeschickte markingId', () => {
    // Der Angriff: eigene Markierung m1 als Feigenblatt, aber das Ergebnis
    // haengt an der fremden Markierung „fremd" derselben Analyse.
    expect(decideResultReview(BEARBEITER, 'verwerfen', 'fremd', 'm1')).toBe(false);
    expect(decideResultReview(BEARBEITER, 'uebernehmen', 'fremd', 'm1')).toBe(false);
  });

  it('erlaubt dem Bearbeiter die Pruefung des eigenen Ergebnisses', () => {
    expect(decideResultReview(BEARBEITER, 'verwerfen', 'm1', 'm1')).toBe(true);
    expect(decideResultReview(BEARBEITER, 'uebernehmen', 'm1', 'm1')).toBe(true);
  });

  it('laesst unzugeordnete Ergebnisse uebernehmen, aber nicht verwerfen', () => {
    // Unkorrelierter n8n-Inbound (markingId null): die Zuordnung ist genau die
    // Aufgabe der recherchierenden Person — das Verwerfen fremder Ablage nicht.
    expect(decideResultReview(BEARBEITER, 'uebernehmen', null, 'm1')).toBe(true);
    expect(decideResultReview(BEARBEITER, 'verwerfen', null, 'm1')).toBe(false);
  });

  it('verweigert die Pruefung an einer nicht zugewiesenen Markierung', () => {
    expect(decideResultReview(BEARBEITER, 'uebernehmen', null, 'fremd')).toBe(false);
    expect(decideResultReview(LESER, 'verwerfen', 'm1', 'm1')).toBe(false);
  });

  it('laesst der vollen Stufe alles', () => {
    expect(decideResultReview(VOLL, 'verwerfen', 'fremd', 'm1')).toBe(true);
    expect(decideResultReview(VOLL, 'uebernehmen', null, 'fremd')).toBe(true);
  });
});
