// Fachkatalog: DSGVO-CONTACT-EXPORT-001
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serializeDsgvoExport } from '../export-package';

describe('DSGVO-Exportpaket', () => {
  it('persistierter Hash verifiziert exakt die heruntergeladenen UTF-8-Bytes', () => {
    const result = serializeDsgvoExport({ name: 'Müller', nested: { value: 1 } });
    expect(result.serialized).toContain('\n  "name"');
    expect(
      result.sha256.equals(
        createHash('sha256').update(Buffer.from(result.serialized, 'utf8')).digest(),
      ),
    ).toBe(true);
  });
});
