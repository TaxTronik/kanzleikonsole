// =============================================================================
// Erzeugt die Referenz-XRechnung (Mischsätze-Fixture) als Datei — Input für
// die KoSIT-Validierung im CI-Job `e-rechnung` (.forgejo/workflows/ci.yml).
//
//   pnpm --filter @taxtronik/web exec tsx src/server/invoicing/cli/generate-sample.ts <ausgabe.xml>
// =============================================================================

import { writeFileSync } from 'node:fs';
import { generateXRechnungCii } from '../xrechnung';
import {
  SAMPLE_INVOICE,
  SAMPLE_SELLER,
  SAMPLE_BUYER,
  SAMPLE_RC_INVOICE,
  SAMPLE_RC_BUYER,
} from '../sample-fixture';

const out = process.argv[2];
// Optionaler zweiter Pfad: Reverse-Charge-Sample (Kategorie AE) für die
// KoSIT-Validierung — deckt den § 13b-Pfad neben den Mischsätzen ab.
const rcOut = process.argv[3];
if (!out) {
  process.stderr.write('Aufruf: tsx generate-sample.ts <ausgabe.xml> [<reverse-charge.xml>]\n');
  process.exit(1);
}

const xml = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
writeFileSync(out, xml, 'utf8');
process.stdout.write(`XRechnung-Sample geschrieben: ${out} (${xml.length} Bytes)\n`);

if (rcOut) {
  const rcXml = generateXRechnungCii(SAMPLE_RC_INVOICE, SAMPLE_SELLER, SAMPLE_RC_BUYER);
  writeFileSync(rcOut, rcXml, 'utf8');
  process.stdout.write(`Reverse-Charge-Sample geschrieben: ${rcOut} (${rcXml.length} Bytes)\n`);
}
