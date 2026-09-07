import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, parseXml } from '../xml';

describe('XML-Entities', () => {
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'behandelt geerbtes %s nicht als unterstützte Entity',
    (name) => {
      const text = `Original: &${name};`;
      expect(decodeXmlEntities(text)).toBe(text);
    },
  );
});

describe('XML-Attributscanner', () => {
  it('verarbeitet lange fehlerhafte Attributnamen ohne quadratisches Backtracking', async () => {
    // A separate process makes the regression's timeout effective even if the
    // synchronous parser blocks. 300 KiB is far below the XLSX entry budget.
    const script = `
      import { parseXml } from ${JSON.stringify(new URL('../xml.ts', import.meta.url).href)};
      const bytes = new TextEncoder().encode('<row ' + 'x'.repeat(300_000) + ' good="yes"/>');
      const events = [];
      parseXml(new TextDecoder().decode(bytes), { onOpen: (name, attrs) => events.push({name, attrs}) });
      process.stdout.write(JSON.stringify(events));
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '' },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'row', attrs: { good: 'yes' } }]);
  }, 15_000);

  it('bewahrt Namespace-Attribute, Entitäten und zitierte Gleichheitszeichen', () => {
    const events: unknown[] = [];
    parseXml(`<sheet name='A &amp; B' r:id="rId2" condition="a > b = c" xml:space="preserve"/>`, {
      onOpen: (name, attrs) => events.push({ name, attrs }),
    });
    expect(events).toEqual([
      {
        name: 'sheet',
        attrs: { name: 'A & B', id: 'rId2', condition: 'a > b = c', space: 'preserve' },
      },
    ]);
  });

  it('überspringt defekte Attribute und liest folgende gültige Werte', () => {
    const events: unknown[] = [];
    parseXml(`<row missing unquoted=no good="yes"/>`, {
      onOpen: (_name, attrs) => events.push(attrs),
    });
    expect(events).toEqual([{ good: 'yes' }]);
  });
});
