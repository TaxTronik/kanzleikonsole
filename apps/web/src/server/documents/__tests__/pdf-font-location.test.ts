// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: PAYROLL-INTAKE-001
// S-10: Die eingebetteten PDF-Schriften liegen serverseitig unter
// apps/web/assets (nicht public/), werden ins Standalone-Paket getraced und
// weiterhin vor der ersten Einbettung per SHA-256 geprüft.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const webRoot = path.resolve(__dirname, '../../../..');
const repoRoot = path.resolve(webRoot, '../..');
const fontRoot = path.join(webRoot, 'assets/fonts/noto');
const manifest = JSON.parse(readFileSync(path.join(fontRoot, 'manifest.json'), 'utf8')) as {
  fonts: Array<{ file: string; sha256: string }>;
};
const originalCwd = process.cwd();
const temporary: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshPdfFontBytes() {
  vi.resetModules();
  return (await import('../pdf-fonts')).pdfFontBytes;
}

function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('S-10: server-only PDF fonts', () => {
  it('serves no Noto file from public/ (no /fonts route without a session)', () => {
    expect(existsSync(path.join(webRoot, 'public/fonts'))).toBe(false);
    // public/identity-assets (build-generated) carries intentionally public PDF.js
    // standard fonts; none of the embedded Noto files may appear anywhere below public/.
    const noto = new Set(manifest.fonts.map((font) => font.sha256));
    expect(
      regularFiles(path.join(webRoot, 'public')).filter((file) =>
        noto.has(createHash('sha256').update(readFileSync(file)).digest('hex')),
      ),
    ).toEqual([]);
  });

  it('keeps all four faces with license texts and checked hashes under assets/fonts/noto', () => {
    expect(manifest.fonts.map((font) => font.file).sort()).toEqual([
      'NotoSans-Bold.ttf',
      'NotoSans-Regular.ttf',
      'NotoSansSC-Bold.otf',
      'NotoSansSC-Regular.otf',
    ]);
    for (const font of manifest.fonts) {
      const bytes = readFileSync(path.join(fontRoot, font.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(font.sha256);
    }
    expect(existsSync(path.join(fontRoot, 'OFL.txt'))).toBe(true);
    expect(existsSync(path.join(fontRoot, 'OFL-NotoSans.txt'))).toBe(true);
  });

  it('traces the font directory into the standalone build for every route', async () => {
    const config = (await import('../../../../next.config.mjs')).default as {
      output?: string;
      outputFileTracingIncludes?: Record<string, string[]>;
    };
    expect(config.output).toBe('standalone');
    // Next.js wertet den Schlüssel als Routen-Glob aus (picomatch, contains);
    // `/**` trifft alle Routen inklusive `/` und der Server Actions der
    // jeweiligen Seite. Derselbe Schlüssel nimmt die Worker-Parser auf (P-22).
    expect(Object.keys(config.outputFileTracingIncludes ?? {})).toEqual(['/**']);
    expect(config.outputFileTracingIncludes?.['/**']).toContain('./assets/fonts/noto/**/*');
    const traced = globSync('assets/fonts/noto/**/*', { cwd: webRoot }).map((file) =>
      path.basename(file),
    );
    for (const required of [
      ...manifest.fonts.map((font) => font.file),
      'manifest.json',
      'OFL.txt',
      'OFL-NotoSans.txt',
    ]) {
      expect(traced).toContain(required);
    }
  });

  it('loads the fonts from apps/web and from the repository/standalone root', async () => {
    for (const cwd of [webRoot, repoRoot]) {
      process.chdir(cwd);
      const pdfFontBytes = await freshPdfFontBytes();
      expect(pdfFontBytes('NotoSans-Regular.ttf').length).toBeGreaterThan(0);
    }
  });

  it('does not fall back to a leftover public/fonts copy', async () => {
    const legacy = mkdtempSync(path.join(tmpdir(), 'pdf-fonts-legacy-'));
    temporary.push(legacy);
    mkdirSync(path.join(legacy, 'public/fonts'), { recursive: true });
    cpSync(fontRoot, path.join(legacy, 'public/fonts/noto'), { recursive: true });
    process.chdir(legacy);
    const pdfFontBytes = await freshPdfFontBytes();
    expect(() => pdfFontBytes('NotoSans-Bold.ttf')).toThrow('PDF-Schriftdateien fehlen');
  });

  it('keeps the SHA-256 check against manifest.json for the new location', async () => {
    const tampered = mkdtempSync(path.join(tmpdir(), 'pdf-fonts-tampered-'));
    temporary.push(tampered);
    const target = path.join(tampered, 'assets/fonts/noto');
    cpSync(fontRoot, target, { recursive: true });
    const file = path.join(target, 'NotoSans-Bold.ttf');
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(file, bytes);
    process.chdir(tampered);
    const pdfFontBytes = await freshPdfFontBytes();
    expect(() => pdfFontBytes('NotoSans-Bold.ttf')).toThrow('nicht mit dem geprüften Stand');
    expect(pdfFontBytes('NotoSans-Regular.ttf').length).toBeGreaterThan(0);
  });
});
