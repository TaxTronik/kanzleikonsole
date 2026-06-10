// =============================================================================
// Erzeugt die Referenz-XRechnung (Mischsätze-Fixture) als Datei — Input für
// die KoSIT-Validierung im CI-Job `e-rechnung` (.forgejo/workflows/ci.yml).
//
//   pnpm --filter @taxtronik/web exec tsx src/server/invoicing/cli/generate-sample.ts <ausgabe.xml>
// =============================================================================

import { writeFileSync } from 'node:fs';
import { generateXRechnungCii } from '../xrechnung';
import { SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER } from '../sample-fixture';

const out = process.argv[2];
if (!out) {
  process.stderr.write('Aufruf: tsx generate-sample.ts <ausgabe.xml>\n');
  process.exit(1);
}

const xml = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
writeFileSync(out, xml, 'utf8');
process.stdout.write(`XRechnung-Sample geschrieben: ${out} (${xml.length} Bytes)\n`);
