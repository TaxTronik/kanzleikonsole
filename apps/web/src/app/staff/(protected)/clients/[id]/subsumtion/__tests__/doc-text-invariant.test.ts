import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/react';
import { Node as PMNode } from '@tiptap/pm/model';
import { docToText, jsonDocToText } from '../doc-text';
import { baseEditorExtensions } from '../editor-extensions';

// Kritische Invariante: der SERVER-Pfad (jsonDocToText, ohne PM/DOM) muss
// bit-genau denselben Plaintext liefern wie der EDITOR-Pfad (docToText über einen
// echten ProseMirror-Knoten). Sonst weicht der serverseitig berechnete Text vom
// gespeicherten sourceText ab → falsche „Text geändert"-Erkennung / kaputte
// Offsets/Hashes. Hier gegen das ECHTE Schema der baseEditorExtensions geprüft.
const schema = getSchema(baseEditorExtensions);
const fromJson = (json: unknown) => PMNode.fromJSON(schema, json as Record<string, unknown>);

const p = (...content: unknown[]) => ({
  type: 'paragraph',
  ...(content.length ? { content } : {}),
});
const t = (text: string, ...marks: string[]) =>
  marks.length
    ? { type: 'text', text, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text };
const h = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [t(text)],
});
const li = (...content: unknown[]) => ({ type: 'listItem', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

const CASES: Array<[string, unknown]> = [
  ['ein Absatz', doc(p(t('Hallo Welt')))],
  ['zwei Absätze', doc(p(t('Eins')), p(t('Zwei')))],
  ['Überschrift + Absatz', doc(h(2, 'Titel'), p(t('Fließtext')))],
  ['Unter-Überschrift', doc(h(3, 'Unter'), p(t('x')))],
  ['hardBreak im Absatz', doc(p(t('Zeile1'), { type: 'hardBreak' }, t('Zeile2')))],
  [
    'Formatierung (marks) ändert Text nicht',
    doc(p(t('Sehr '), t('wichtig', 'bold'), t(' und '), t('kursiv', 'italic'))),
  ],
  ['leerer Absatz zwischen Text', doc(p(t('A')), p(), p(t('B')))],
  ['leerer Absatz am Ende', doc(p(t('A')), p())],
  [
    'Aufzählung (bulletList)',
    doc(
      p(t('Davor.')),
      { type: 'bulletList', content: [li(p(t('Eins'))), li(p(t('Zwei')))] },
      p(t('Danach.')),
    ),
  ],
  ['nummerierte Liste', doc({ type: 'orderedList', content: [li(p(t('A'))), li(p(t('B')))] })],
  ['blockquote', doc({ type: 'blockquote', content: [p(t('Zitat'))] }, p(t('Normal')))],
  ['codeBlock', doc({ type: 'codeBlock', content: [t('const x = 1')] }, p(t('Text')))],
];

describe('jsonDocToText === docToText (gegen echtes Schema)', () => {
  it.each(CASES)('%s', (_name, json) => {
    const viaPm = docToText(fromJson(json)).text;
    const viaJson = jsonDocToText(json);
    expect(viaJson).toBe(viaPm);
  });
});
