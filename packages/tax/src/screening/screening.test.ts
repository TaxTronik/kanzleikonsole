// Fachkatalog: GWG-SCREENING-001.
import { describe, it, expect, vi } from 'vitest';
import { normalizeScreeningName, screenEu, sourceIsFresh, type SanctionEntry } from './core';
import { parseEuSanctionsXml, fetchEuSanctions, EU_SANCTIONS_URL } from './source';
const xml = `<?xml version="1.0"?><export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-08-05T16:47:04+02:00" globalFileId="184961"><sanctionEntity logicalId="13" euReferenceNumber="EU.27.28"><subjectType code="person"/><nameAlias wholeName="José Müller" strong="true"/><nameAlias wholeName="Jose Muller" strong="false"/><birthdate birthdate="1957-01-02" year="1957" circa="false"/><citizenship countryIso2Code="DE"/><regulation numberTitle="1210/2003"><publicationUrl>https://eur-lex.europa.eu/</publicationUrl></regulation></sanctionEntity></export>`;
describe('GWG-SCREENING-001: local candidate engine, not a clearance', () => {
  it('extracts all aliases, exact/partial DOB and source identity', () => {
    const d = parseEuSanctionsXml(xml);
    expect(d.sourceVersion).toBe('184961');
    expect(d.entries[0]!.names).toHaveLength(2);
    expect(d.entries[0]!.birthDates[0]!.date).toBe('1957-01-02');
    expect(d.entries[0]!.regulations[0]!.url).toContain('eur-lex');
  });
  it('refuses DTD/entity expansion, invalid namespace and incomplete entities', () => {
    expect(() => parseEuSanctionsXml('<!DOCTYPE x [<!ENTITY s "test">]>' + xml)).toThrow(
      'unzulässige',
    );
    expect(() =>
      parseEuSanctionsXml(
        xml.replace('http://eu.europa.ec/fpi/fsd/export', 'https://attacker.invalid/'),
      ),
    ).toThrow('Schema');
    expect(() => parseEuSanctionsXml(xml.replace(/<nameAlias[^>]*\/>/g, ''))).toThrow(
      'unvollständig',
    );
    expect(() => parseEuSanctionsXml(xml.replace('</export>', ''))).toThrow('gültiges XML');
  });
  it('normalizes accents, punctuation and token order; preserves original evidence', () => {
    expect(normalizeScreeningName('  José—Müller ')).toBe('jose muller');
    const result = screenEu(
      { name: 'Muller Jose', role: 'Mandant' },
      parseEuSanctionsXml(xml).entries,
    );
    expect(result.status).toBe('CANDIDATES');
    expect(result.candidates[0]!.score).toBe(1);
    expect(result.candidates[0]!.alias).toBe('José Müller');
  });
  it('never drops a name candidate for a conflicting or absent date of birth', () => {
    const d = parseEuSanctionsXml(xml).entries;
    expect(
      screenEu({ name: 'Jose Muller', birthDate: '1999-01-01', role: 'Vertretung' }, d)
        .candidates[0]!.birthMatch,
    ).toBe('CONFLICT');
    expect(
      screenEu({ name: 'Jose Muller', birthDate: '1957-01-02', role: 'Vertretung' }, d)
        .candidates[0]!.birthMatch,
    ).toBe('EXACT');
    expect(
      screenEu({ name: 'Jose Muller', birthDate: '1957-07-02', role: 'Vertretung' }, d)
        .candidates[0]!.birthMatch,
    ).toBe('YEAR_ONLY');
  });
  it('labels no-hit and truncation honestly and validates dates', () => {
    const entries = parseEuSanctionsXml(xml).entries;
    expect(screenEu({ name: 'Unrelated Sample Company', role: 'Mandant' }, entries).status).toBe(
      'NO_NAME_CANDIDATE',
    );
    const many: SanctionEntry[] = Array.from({ length: 101 }, (_, i) => ({
      ...entries[0]!,
      id: String(i),
    }));
    const result = screenEu({ name: 'Jose Muller', role: 'Mandant' }, many);
    expect(result.candidates).toHaveLength(100);
    expect(result.candidateCount).toBe(101);
    expect(result.truncated).toBe(true);
    expect(() =>
      screenEu({ name: 'Jose Muller', role: 'Mandant', birthDate: '2026-02-30' }, entries),
    ).toThrow('ungültig');
  });
  it('checks successful fetch time, not publication age; any failed refresh closes gate', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    expect(sourceIsFresh(new Date('2026-08-30'), null, now)).toBe(true);
    expect(sourceIsFresh(new Date('2026-08-28'), null, now)).toBe(false);
    expect(sourceIsFresh(now, 'Download failed', now)).toBe(false);
  });
  it('uses only the allowlisted URL and rejects redirects/oversize before parsing', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('x', { status: 200, headers: { 'content-length': String(65 * 1024 * 1024) } }),
      );
    await expect(fetchEuSanctions(fetcher)).rejects.toThrow('groß');
    expect(fetcher).toHaveBeenCalledWith(
      EU_SANCTIONS_URL,
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });
  it('rejects a tiny but well-formed live dataset instead of replacing known-good data', async () => {
    await expect(fetchEuSanctions(vi.fn().mockResolvedValue(new Response(xml)))).rejects.toThrow(
      'wenige',
    );
  });
});
