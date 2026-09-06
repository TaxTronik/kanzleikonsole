// Regenerate only after reviewing the pinned upstream assets and OFL notices.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fontkit = createRequire(require.resolve('pdfkit'))('fontkit');
const directory = path.resolve('apps/web/public/fonts/noto');
const manifest = JSON.parse(readFileSync(path.join(directory, 'upstream.json'), 'utf8'));
for (const item of manifest.fonts) {
  const bytes = readFileSync(path.join(directory, item.file));
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
    throw new Error('Font source hash mismatch');
  const font = fontkit.create(bytes);
  const ranges = [];
  for (const cp of [...font.characterSet].sort((a, b) => a - b)) {
    if (!font.hasGlyphForCodePoint(cp)) continue;
    const last = ranges.at(-1);
    if (last && last[1] + 1 === cp) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  item.fullName = font.fullName;
  item.coverage = ranges;
}
writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
