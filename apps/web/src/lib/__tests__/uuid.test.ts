import { describe, it, expect } from 'vitest';
import { isUuid } from '../uuid';

describe('isUuid', () => {
  it('akzeptiert kanonische UUIDs (case-insensitiv)', () => {
    expect(isUuid('a9355051-c481-444c-951f-0219743974eb')).toBe(true);
    expect(isUuid('A9355051-C481-444C-951F-0219743974EB')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('lehnt Nicht-UUID-Eingaben ab', () => {
    expect(isUuid('foo')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('123')).toBe(false);
    // Zu kurz / zu lang / falsche Trenner.
    expect(isUuid('a9355051-c481-444c-951f-0219743974e')).toBe(false);
    expect(isUuid('a9355051c481444c951f0219743974eb')).toBe(false);
    // Kein SQL/Path-Traversal-Payload rutscht durch.
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid('../../etc/passwd')).toBe(false);
    // Nicht-Hex-Zeichen.
    expect(isUuid('g9355051-c481-444c-951f-0219743974eb')).toBe(false);
  });
});
