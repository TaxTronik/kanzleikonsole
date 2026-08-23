#!/usr/bin/env node

import { checkIndexes, loadCatalog, reviewContentHash, writeIndexes } from './lib.mjs';

const command = process.argv[2] ?? 'check';
const rootDir = process.cwd();

try {
  const rules = loadCatalog(rootDir);
  switch (command) {
    case 'validate':
      console.log(`Fachkatalog gültig: ${rules.length} Regeln.`);
      break;
    case 'generate':
      await writeIndexes(rootDir, rules);
      console.log(`Fachkatalog-Indizes erzeugt: ${rules.length} Regeln.`);
      break;
    case 'check-index':
      await checkIndexes(rootDir, rules);
      console.log(`Fachkatalog-Indizes aktuell: ${rules.length} Regeln.`);
      break;
    case 'check':
      await checkIndexes(rootDir, rules);
      console.log(`Fachkatalog gültig und aktuell: ${rules.length} Regeln.`);
      break;
    case 'review-hash': {
      const id = process.argv[3];
      const rule = rules.find((entry) => entry.id === id);
      if (!rule) throw new Error(`Unbekannte oder fehlende Regel-ID „${id ?? ''}“.`);
      console.error(
        'Hinweis: Dieser Hash bindet nur den Inhalt. Identität und Vier-Augen-Prüfung brauchen geschützte Repository-Governance oder eine signierte Attestation.',
      );
      console.log(reviewContentHash(rule, rule.body));
      break;
    }
    default:
      throw new Error(
        `Unbekannter Befehl „${command}“. Erlaubt: validate, generate, check-index, check, review-hash.`,
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
