import { describe, expect, it } from 'vitest';
import { extractMentions, splitByMentions } from '../reminder-mentions';

const STAFF = [
  { id: 'maria', fullName: 'Maria Mitarbeiterin' },
  { id: 'otto', fullName: 'Otto Unbeteiligt' },
  { id: 'max', fullName: 'Max Muster' },
  { id: 'maxm', fullName: 'Max Mustermann' },
];

describe('extractMentions', () => {
  it('erkennt volle Namen mit Leerzeichen', () => {
    expect(extractMentions('@Maria Mitarbeiterin kannst du das prüfen?', STAFF)).toEqual(['maria']);
  });

  it('ist unabhängig von Groß-/Kleinschreibung', () => {
    expect(extractMentions('bitte @maria mitarbeiterin fragen', STAFF)).toEqual(['maria']);
  });

  it('findet mehrere Erwähnungen und entdoppelt', () => {
    const ids = extractMentions(
      '@Maria Mitarbeiterin und @Otto Unbeteiligt — @Maria Mitarbeiterin zuerst.',
      STAFF,
    );
    expect(ids.sort()).toEqual(['maria', 'otto']);
  });

  it('stolpert nicht über E-Mail-Adressen', () => {
    // Nach dem @ folgt kein Personenname — kein Treffer.
    expect(extractMentions('Antwort an info@kanzlei.de senden', STAFF)).toEqual([]);
  });

  it('erwähnt niemanden ohne @', () => {
    expect(extractMentions('Maria Mitarbeiterin ist zuständig', STAFF)).toEqual([]);
  });

  it('trifft NUR den längeren Namen, wenn ein kürzerer sein Präfix ist', () => {
    // „@Max Mustermann" enthält „@Max Muster" — benachrichtigt wird genau der,
    // der auch in der Anzeige leuchtet: der längere.
    expect(extractMentions('@Max Mustermann bitte übernehmen', STAFF)).toEqual(['maxm']);
  });

  it('reicht der eindeutige Vorname', () => {
    expect(extractMentions('@Maria kannst du übernehmen?', STAFF)).toEqual(['maria']);
    expect(extractMentions('bitte @otto fragen', STAFF)).toEqual(['otto']);
  });

  it('lässt mehrdeutige Vornamen bewusst leer', () => {
    // Zwei Personen namens Max — „@Max" allein wäre Raterei, das löst das
    // Autocomplete-Dropdown auf.
    expect(extractMentions('@Max bitte melden', STAFF)).toEqual([]);
  });

  it('respektiert Wortgrenzen', () => {
    // „@Mariam" ist nicht „@Maria", „@Maria Mitarbeiterinnen" nicht Maria M.
    expect(extractMentions('@Mariam bitte melden', STAFF)).toEqual([]);
    expect(extractMentions('@Maria Mitarbeiterinnen gesucht', STAFF)).toEqual(['maria']);
  });
});

describe('splitByMentions', () => {
  it('trennt Erwähnungen vom Fließtext', () => {
    const teile = splitByMentions('Frage an @Maria Mitarbeiterin: passt das?', STAFF);
    expect(teile).toEqual([
      { text: 'Frage an ', mention: false },
      { text: '@Maria Mitarbeiterin', mention: true },
      { text: ': passt das?', mention: false },
    ]);
  });

  it('bevorzugt den längeren Namen bei Präfix-Kollision', () => {
    const teile = splitByMentions('@Max Mustermann bitte melden', STAFF);
    expect(teile[0]).toEqual({ text: '@Max Mustermann', mention: true });
  });

  it('lässt Text ohne Erwähnung unangetastet', () => {
    expect(splitByMentions('nur Text', STAFF)).toEqual([{ text: 'nur Text', mention: false }]);
  });

  it('erhält den Text vollständig (Roundtrip)', () => {
    const body = 'A @Otto Unbeteiligt B @Maria Mitarbeiterin C';
    const zusammen = splitByMentions(body, STAFF)
      .map((s) => s.text)
      .join('');
    expect(zusammen).toBe(body);
  });
});
