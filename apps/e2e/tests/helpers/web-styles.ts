import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';

const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const webRoot = dirname(webRequire.resolve('./package.json'));
let stylesheet: Promise<string> | undefined;

async function compileWebStyles() {
  const postcss = webRequire('postcss') as typeof import('postcss').default;
  const tailwind = webRequire(
    '@tailwindcss/postcss',
  ) as typeof import('@tailwindcss/postcss').default;
  const from = join(webRoot, 'src/app/globals.css');
  const { css } = await postcss([tailwind({ base: webRoot })]).process(
    await readFile(from, 'utf8'),
    { from },
  );
  // Ein externes Stylesheet verliert sein UTF-8-BOM beim Dekodieren. Als
  // Inline-Text würde es die erste @layer-Regel samt Theme-Variablen verschlucken.
  return css.replace(/^\uFEFF/, '');
}

export async function addWebStyles(page: Page) {
  stylesheet ??= compileWebStyles();
  await page.addStyleTag({ content: await stylesheet });
}
