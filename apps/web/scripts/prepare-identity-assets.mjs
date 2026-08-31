import { createRequire } from 'node:module';
import { cp, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No runtime downloads: all executable/model assets come from the pinned lockfile.
const require = createRequire(import.meta.url);
const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/identity-assets',
);
const tesseractRequire = createRequire(require.resolve('tesseract.js/package.json'));
const packageRoot = (name) =>
  path.dirname(
    (name === 'tesseract.js-core' ? tesseractRequire : require).resolve(`${name}/package.json`),
  );
await mkdir(target, { recursive: true });
await copyFile(
  path.join(packageRoot('tesseract.js'), 'dist/worker.min.js'),
  path.join(target, 'ocr-worker.js'),
);
const core = packageRoot('tesseract.js-core');
for (const file of await readdir(core)) {
  if (/^tesseract-core.*\.(?:js|wasm)$/.test(file))
    await copyFile(path.join(core, file), path.join(target, file));
}
for (const language of ['deu', 'eng']) {
  await copyFile(
    path.join(packageRoot(`@tesseract.js-data/${language}`), `4.0.0/${language}.traineddata.gz`),
    path.join(target, `${language}.traineddata.gz`),
  );
}
const pdf = packageRoot('pdfjs-dist');
await copyFile(path.join(pdf, 'build/pdf.worker.min.mjs'), path.join(target, 'pdf.worker.min.mjs'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(path.join(pdf, directory), path.join(target, directory), { recursive: true });
}
for (const [name, prefix] of [
  ['tesseract.js', 'ocr'],
  ['tesseract.js-core', 'core'],
  ['pdfjs-dist', 'pdf'],
  ['@tesseract.js-data/deu', 'deu'],
  ['@tesseract.js-data/eng', 'eng'],
]) {
  const license = (await readdir(packageRoot(name))).find((file) => /^license(?:\.|$)/i.test(file));
  if (license)
    await copyFile(path.join(packageRoot(name), license), path.join(target, `${prefix}-LICENSE`));
}
console.log('Lokale Ausweiserkennung: Worker, PDF-Runtime und Sprachmodelle bereitgestellt.');
