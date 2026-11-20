// =============================================================================
// HTML-Einfügestellen der Web-App (SAST-Befund XSS, dangerouslySetInnerHTML).
//
// Prüft die Regel html-sink/no-html-sink aus eslint.config.mjs mit der echten
// Konfiguration: dangerouslySetInnerHTML (JSX und Objektschlüssel),
// innerHTML-/outerHTML-Zuweisungen und insertAdjacentHTML sind außerhalb der
// begründeten Ausnahmen Fehler; Tests bleiben frei. Die Ausnahmen dürfen nicht
// veralten, und die früher gemeldeten Markdown-Stellen nutzen MarkdownContent.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { HTML_SINK_ALLOWLIST } from '../../../../eslint.config.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function senken(file: string, code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return result!.messages.filter((m) => m.ruleId === 'html-sink/no-html-sink').map((m) => m.line);
}

const SENKEN = [
  'export const a = (h: string) => <div dangerouslySetInnerHTML={{ __html: h }} />;',
  "export const b = (h: string) => ({ dangerouslySetInnerHTML: { __html: h }, ['dangerouslySetInnerHTML']: 1 });",
  'export const c = (el: HTMLElement, h: string) => { el.innerHTML = h; };',
  'export const d = (el: HTMLElement, h: string) => { el.outerHTML = h; };',
  "export const e = (el: HTMLElement, h: string) => el.insertAdjacentHTML('beforeend', h);",
  'export const f = (el: HTMLElement) => el.innerHTML;',
  'export const g = (t: string) => <p>{t}</p>;',
].join('\n');

describe('HTML-Einfügestellen der Web-App', () => {
  it('meldet jede HTML-Einfügestelle außerhalb der Ausnahmen', async () => {
    await expect(senken('apps/web/src/components/xss-probe.tsx', SENKEN)).resolves.toEqual([
      1, 2, 2, 3, 4, 5,
    ]);
    await expect(
      senken('apps/web/src/app/staff/(protected)/knowledge/xss-probe.tsx', SENKEN),
    ).resolves.toEqual([1, 2, 2, 3, 4, 5]);
  });

  it('lässt Tests und die begründeten Ausnahmen zu', async () => {
    await expect(senken('apps/web/src/components/__tests__/xss.test.tsx', SENKEN)).resolves.toEqual(
      [],
    );
    for (const { file } of HTML_SINK_ALLOWLIST) {
      await expect(senken(file, SENKEN), file).resolves.toEqual([]);
    }
  });

  it('führt keine veralteten oder unbegründeten Ausnahmen', () => {
    for (const { file, reason } of HTML_SINK_ALLOWLIST) {
      expect(reason.trim().length, file).toBeGreaterThan(20);
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain('dangerouslySetInnerHTML');
    }
  });

  it('rendert die früher gemeldeten Markdown-Stellen über MarkdownContent', async () => {
    for (const file of [
      'apps/web/src/app/poa/sign/page.tsx',
      'apps/web/src/app/staff/(protected)/poa/[id]/page.tsx',
      'apps/web/src/app/staff/(protected)/knowledge/[id]/page.tsx',
      'apps/web/src/app/staff/(protected)/knowledge/page.tsx',
      'apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/research-results-block.tsx',
      'apps/web/src/components/knowledge-context.tsx',
      'apps/web/src/components/notice-view.tsx',
      'apps/web/src/components/document-preview.tsx',
    ]) {
      await expect(senken(file, readFileSync(join(ROOT, file), 'utf8')), file).resolves.toEqual([]);
    }
  });
});
