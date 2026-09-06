import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { SanctionEntry } from './core';
export const EU_SANCTIONS_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const MAX_BYTES = 64 * 1024 * 1024;
const list = (value: unknown): Record<string, unknown>[] =>
  value == null ? [] : ((Array.isArray(value) ? value : [value]) as Record<string, unknown>[]);
const s = (value: unknown) => (typeof value === 'string' ? value : '');

export function parseEuSanctionsXml(xml: string, now = new Date()) {
  if (Buffer.byteLength(xml) > MAX_BYTES || /<!\s*(DOCTYPE|ENTITY)/i.test(xml))
    throw new Error('EU-Datei enthält unzulässige XML-Deklarationen oder ist zu groß.');
  if (XMLValidator.validate(xml) !== true) throw new Error('EU-Datei ist kein gültiges XML.');
  const root = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
  }).parse(xml)?.export;
  if (!root || root.xmlns !== 'http://eu.europa.ec/fpi/fsd/export')
    throw new Error('Unerwartetes EU-XML-Schema.');
  const publishedAt = new Date(s(root.generationDate));
  if (
    !Number.isFinite(publishedAt.getTime()) ||
    publishedAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000 ||
    !s(root.globalFileId)
  )
    throw new Error('EU-Publikationsstand fehlt oder ist ungültig.');
  const entries: SanctionEntry[] = list(root.sanctionEntity).map((e) => ({
    id: s(e.logicalId),
    euReference: s(e.euReferenceNumber),
    type: s(list(e.subjectType)[0]?.code),
    names: list(e.nameAlias)
      .map((a) => ({
        name:
          s(a.wholeName) ||
          [s(a.firstName), s(a.middleName), s(a.lastName)].filter(Boolean).join(' '),
        strong: a.strong === 'true',
      }))
      .filter((a) => a.name.trim()),
    birthDates: list(e.birthdate).map((d) => ({
      date: s(d.birthdate),
      year: s(d.year),
      circa: d.circa === 'true',
    })),
    countries: [
      ...new Set(
        list(e.citizenship)
          .map((c) => s(c.countryIso2Code))
          .filter(Boolean),
      ),
    ],
    regulations: list(e.regulation).map((r) => ({
      title: s(r.numberTitle),
      url: s(r.publicationUrl),
    })),
  }));
  if (
    !entries.length ||
    entries.length > 100000 ||
    entries.some((e) => !e.id || !e.euReference || !e.names.length) ||
    new Set(entries.map((e) => e.id)).size !== entries.length
  )
    throw new Error('EU-Datei ist leer, unvollständig oder enthält doppelte Kennungen.');
  return { publishedAt, sourceVersion: s(root.globalFileId), entries };
}

/** Fixed allowlisted download; no client names/IDs ever leave the installation. */
export async function fetchEuSanctions(fetcher: typeof fetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetcher(EU_SANCTIONS_URL, {
      redirect: 'error',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body)
      throw new Error(`EU-Download fehlgeschlagen (HTTP ${response.status}).`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new Error('EU-Datei ist zu groß.');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_BYTES) throw new Error('EU-Datei ist zu groß.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    const parsed = parseEuSanctionsXml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // A live consolidated list shrinking to a tiny successful XML must not replace the known-good list.
    if (parsed.entries.length < 100)
      throw new Error(
        'EU-Datei enthält unerwartet wenige Einträge; manuelle Prüfung erforderlich.',
      );
    return {
      ...parsed,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceUrl: EU_SANCTIONS_URL,
    };
  } finally {
    clearTimeout(timer);
  }
}
