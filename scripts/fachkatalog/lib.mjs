import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { URL } from 'node:url';
import yaml from 'js-yaml';
import { format as formatWithPrettier } from 'prettier';

export const REVIEW_STATUSES = ['unreviewed', 'in_review', 'approved', 'superseded'];
export const IMPLEMENTATION_STATUSES = [
  'not_assessed',
  'not_implemented',
  'partial',
  'implemented',
  'deviates',
  'not_applicable',
];
export const RULE_TYPES = [
  'statute',
  'administrative_guidance',
  'technical_standard',
  'professional_interpretation',
  'office_policy',
  'product_rule',
];
export const SOURCE_KINDS = [
  'official_law',
  'official_guidance',
  'technical_standard',
  'case_law',
  'professional_literature',
  'internal_policy',
  'product_documentation',
];
export const REQUIRED_HEADINGS = [
  'Kurzfassung',
  'Wann gilt die Regel?',
  'Benötigte Angaben',
  'Entscheidungslogik',
  'Ausnahmen und Grenzfälle',
  'Beispiele',
  'Umsetzung in TaxTronik',
  'Bekannte Abweichungen und Grenzen',
  'Fachliche Prüffragen',
  'Technische Nachweise',
];

const TOP_LEVEL_KEYS = [
  'id',
  'title',
  'domain',
  'rule_type',
  'jurisdiction',
  'validity',
  'professional_owner_role',
  'professional_review',
  'implementation',
  'sources',
  'code_refs',
  'test_refs',
  'feature_refs',
  'related_rules',
  'tags',
];
const ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d{3}$/;
const DOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LOCAL_SOURCE_KINDS = new Set(['internal_policy', 'product_documentation']);
const AUTHORITATIVE_SOURCE_HOSTS = {
  official_law: [
    'gesetze-im-internet.de',
    'recht.bund.de',
    'eur-lex.europa.eu',
    'gesetze-bayern.de',
    'recht.nrw.de',
  ],
  official_guidance: [
    'bund.de',
    'bundesfinanzministerium.de',
    'bundesanzeiger.de',
    'elster.de',
    'bravors.brandenburg.de',
    'verwaltungsvorschriften-im-internet.de',
  ],
  case_law: [
    'bundesfinanzhof.de',
    'bundesgerichtshof.de',
    'bundesverfassungsgericht.de',
    'curia.europa.eu',
    'rechtsprechung-im-internet.de',
  ],
};
const REQUIRED_PRIMARY_KIND = {
  statute: 'official_law',
  administrative_guidance: 'official_guidance',
  technical_standard: 'technical_standard',
};
const CODE_REFERENCE_PATTERN =
  /^(?:(?:apps|packages|scripts)\/.+\.(?:[cm]?[jt]sx?|sql|prisma|sh|py)|\.forgejo\/workflows\/.+\.ya?ml)$/;
const TEST_REFERENCE_PATTERN =
  /^(?:apps|packages|scripts)\/.+(?:\/__tests__\/[^/]+|\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/;

const REVIEW_LABELS = {
  unreviewed: 'Ungeprüfter Entwurf',
  in_review: 'In fachlicher Prüfung',
  approved: 'Freigabe dokumentiert',
  superseded: 'Abgelöst',
};
const IMPLEMENTATION_LABELS = {
  not_assessed: 'Nicht erhoben',
  not_implemented: 'Nicht umgesetzt',
  partial: 'Teilweise umgesetzt',
  implemented: 'Umgesetzt und getestet',
  deviates: 'Weicht ab',
  not_applicable: 'Nicht anwendbar',
};
const DOMAIN_LABELS = {
  'fristen-und-bescheide': 'Fristen und Bescheide',
  rechnungen: 'Rechnungen',
  gwg: 'Geldwäschegesetz',
  datenschutz: 'Datenschutz',
  'dokumente-und-aufbewahrung': 'Dokumente und Aufbewahrung',
  'mandat-und-zugriff': 'Mandat und Zugriff',
  'vollmachten-und-signaturen': 'Vollmachten und Signaturen',
  'audit-und-assurance': 'Audit und Software-Assurance',
  'bwa-und-planung': 'BWA und Planung',
  'subsumtion-und-tcms': 'Subsumtion und TCMS-Produktgrenzen',
};

const SCOPE_DEFINITION_PATH = 'docs/fachkatalog/SCOPE.md';

function toPosix(value) {
  return value.split(sep).join('/');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors, file, message) {
  errors.push(`${file}: ${message}`);
}

export function latestPlausibleCalendarDate(now = new Date()) {
  const timestamp = now instanceof Date ? now.valueOf() : Number.NaN;
  if (Number.isNaN(timestamp)) {
    throw new TypeError('now muss ein gültiges Date-Objekt sein.');
  }

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const calendar = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${calendar.year}-${calendar.month}-${calendar.day}`;
}

function validateKnownKeys(value, allowed, label, errors, file) {
  if (!isPlainObject(value)) {
    addError(errors, file, `${label} muss ein Objekt sein.`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    addError(errors, file, `${label} enthält unbekannte Felder: ${unknown.join(', ')}.`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    addError(errors, file, `${label} fehlen Pflichtfelder: ${missing.join(', ')}.`);
  }
  return unknown.length === 0 && missing.length === 0;
}

function validateDate(value, label, errors, file, { nullable = true, notFuture = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    addError(
      errors,
      file,
      `${label} muss ein ISO-Datum YYYY-MM-DD${nullable ? ' oder null' : ''} sein.`,
    );
    return;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    addError(errors, file, `${label} ist kein gültiges Kalenderdatum.`);
  } else if (notFuture && value > latestPlausibleCalendarDate()) {
    addError(errors, file, `${label} darf nicht in der Zukunft liegen.`);
  }
}

function validateString(value, label, errors, file, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum) {
    addError(errors, file, `${label} muss mindestens ${minimum} Zeichen enthalten.`);
  }
}

function validateStringArray(value, label, errors, file, { nonempty = false } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, file, `${label} muss eine Liste sein.`);
    return [];
  }
  if (nonempty && value.length === 0) {
    addError(errors, file, `${label} darf nicht leer sein.`);
  }
  value.forEach((entry, index) => validateString(entry, `${label}[${index}]`, errors, file));
  if (new Set(value).size !== value.length) {
    addError(errors, file, `${label} enthält doppelte Einträge.`);
  }
  return value;
}

export function assertRepositoryFile(rootDir, reference, label, errors, file) {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    isAbsolute(reference) ||
    reference.includes('\\') ||
    reference.split('/').includes('..')
  ) {
    addError(
      errors,
      file,
      `${label} muss ein POSIX-relativer Repository-Pfad ohne „..“ sein: ${String(reference)}.`,
    );
    return null;
  }

  const root = realpathSync(resolve(rootDir));
  let current = root;
  for (const segment of reference.split('/')) {
    if (!segment || segment === '.') {
      addError(errors, file, `${label} enthält ein ungültiges Pfadsegment: ${reference}.`);
      return null;
    }
    if (!existsSync(current) || !lstatSync(current).isDirectory()) {
      addError(errors, file, `${label} existiert nicht: ${reference}.`);
      return null;
    }
    const exactEntries = readdirSync(current);
    if (!exactEntries.includes(segment)) {
      addError(
        errors,
        file,
        `${label} existiert nicht mit exakter Groß-/Kleinschreibung: ${reference}.`,
      );
      return null;
    }
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      addError(errors, file, `${label} darf keinen symbolischen Link verwenden: ${reference}.`);
      return null;
    }
  }
  if (!existsSync(current) || !lstatSync(current).isFile()) {
    addError(errors, file, `${label} muss auf eine vorhandene Datei zeigen: ${reference}.`);
    return null;
  }
  const resolvedFile = realpathSync(current);
  const outside = relative(root, resolvedFile);
  if (outside.startsWith('..') || isAbsolute(outside)) {
    addError(errors, file, `${label} verlässt das Repository: ${reference}.`);
    return null;
  }
  return resolvedFile;
}

function walkMarkdown(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(fullPath));
    if (entry.isFile() && entry.name.endsWith('.md')) result.push(fullPath);
  }
  return result.sort((left, right) => left.localeCompare(right, 'de'));
}

function safeRepositoryDirectory(rootDir, repositoryPath) {
  const root = realpathSync(resolve(rootDir));
  let current = root;
  for (const segment of repositoryPath.split('/')) {
    if (!readdirSync(current).includes(segment)) {
      throw new Error(`Repository-Verzeichnis fehlt: ${repositoryPath}.`);
    }
    current = join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Repository-Verzeichnis darf kein symbolischer Link sein: ${repositoryPath}.`,
      );
    }
    if (!info.isDirectory()) {
      throw new Error(`Repository-Pfad ist kein Verzeichnis: ${repositoryPath}.`);
    }
  }
  return current;
}

export function parseRuleSource(source, file = '<Regel>') {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: YAML-Frontmatter muss die Datei mit zwei --- Begrenzungen eröffnen.`);
  }
  let metadata;
  try {
    metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA, json: false });
  } catch (error) {
    throw new Error(`${file}: ungültiges YAML-Frontmatter: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(metadata)) {
    throw new Error(`${file}: Frontmatter muss ein Objekt sein.`);
  }
  return { metadata, body: match[2] };
}

function levelTwoSections(body) {
  const matches = [];
  let offset = 0;
  let fence = null;
  for (const lineWithEnding of body.match(/.*(?:\r?\n|$)/g) ?? []) {
    if (lineWithEnding.length === 0) continue;
    const line = lineWithEnding.replace(/\r?\n$/, '');
    const fenceMarker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMarker) {
      const marker = fenceMarker[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      offset += lineWithEnding.length;
      continue;
    }
    if (fence === null) {
      const heading = line.match(/^## ([^\r\n]+)$/);
      if (heading) {
        matches.push({ heading: heading[1], position: offset, length: line.length });
      }
    }
    offset += lineWithEnding.length;
  }
  return matches.map((match, index) => ({
    heading: match.heading,
    position: match.position,
    content: body
      .slice(match.position + match.length, matches[index + 1]?.position ?? body.length)
      .trim(),
  }));
}

export function extractSection(body, heading) {
  return levelTwoSections(body).find((section) => section.heading === heading)?.content ?? '';
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function reviewContentHash(metadata, body) {
  const excluded = new Set([
    'professional_review',
    'implementation',
    'code_refs',
    'test_refs',
    'feature_refs',
  ]);
  const professionalMetadata = Object.fromEntries(
    TOP_LEVEL_KEYS.filter((key) => !excluded.has(key) && key in metadata).map((key) => [
      key,
      metadata[key],
    ]),
  );
  const normalizedBody = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  const payload = JSON.stringify(
    canonicalize({ metadata: professionalMetadata, body: normalizedBody }),
  );
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function extractSummary(body) {
  const section = extractSection(body, 'Kurzfassung');
  const paragraph = section.split(/\r?\n\s*\r?\n/)[0] ?? '';
  return paragraph
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateSource(source, index, rootDir, errors, file) {
  const label = `sources[${index}]`;
  if (!isPlainObject(source)) {
    addError(errors, file, `${label} muss ein Objekt sein.`);
    return;
  }
  const allowed = ['kind', 'citation', 'checked_at', 'primary', 'url', 'path'];
  const required = ['kind', 'citation', 'checked_at', 'primary'];
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in source));
  if (unknown.length > 0) {
    addError(errors, file, `${label} enthält unbekannte Felder: ${unknown.join(', ')}.`);
  }
  if (missing.length > 0) {
    addError(errors, file, `${label} fehlen Pflichtfelder: ${missing.join(', ')}.`);
  }
  if (!SOURCE_KINDS.includes(source.kind)) {
    addError(errors, file, `${label}.kind hat einen unbekannten Wert: ${String(source.kind)}.`);
  }
  validateString(source.citation, `${label}.citation`, errors, file, 3);
  validateDate(source.checked_at, `${label}.checked_at`, errors, file, {
    nullable: false,
    notFuture: true,
  });
  if (typeof source.primary !== 'boolean') {
    addError(errors, file, `${label}.primary muss true oder false sein.`);
  }
  const expectsLocalPath = LOCAL_SOURCE_KINDS.has(source.kind);
  if (expectsLocalPath && (!source.path || source.url !== undefined)) {
    addError(
      errors,
      file,
      `${label} mit kind ${String(source.kind)} braucht path und darf keine url tragen.`,
    );
  }
  if (!expectsLocalPath && (!source.url || source.path !== undefined)) {
    addError(
      errors,
      file,
      `${label} mit kind ${String(source.kind)} braucht url und darf keinen path tragen.`,
    );
  }
  if (!expectsLocalPath && source.url) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') throw new Error('Protokoll ist nicht HTTPS');
      const allowedHosts = AUTHORITATIVE_SOURCE_HOSTS[source.kind];
      if (
        allowedHosts &&
        !allowedHosts.some(
          (allowedHost) => url.hostname === allowedHost || url.hostname.endsWith(`.${allowedHost}`),
        )
      ) {
        addError(
          errors,
          file,
          `${label}.url nutzt für ${String(source.kind)} keine freigegebene amtliche Domain: ${url.hostname}.`,
        );
      }
    } catch {
      addError(errors, file, `${label}.url muss eine gültige HTTPS-URL sein.`);
    }
  } else if (expectsLocalPath && source.path) {
    assertRepositoryFile(rootDir, source.path, `${label}.path`, errors, file);
  }
}

function validateMetadata(metadata, context) {
  const { rootDir, file, relativeFile, errors } = context;
  validateKnownKeys(metadata, TOP_LEVEL_KEYS, 'Frontmatter', errors, file);
  validateString(metadata.id, 'id', errors, file, 5);
  if (typeof metadata.id === 'string' && !ID_PATTERN.test(metadata.id)) {
    addError(errors, file, 'id entspricht nicht dem Muster AREA-THEMA-001.');
  }
  validateString(metadata.title, 'title', errors, file, 3);
  validateString(metadata.domain, 'domain', errors, file, 2);
  if (typeof metadata.domain === 'string' && !DOMAIN_PATTERN.test(metadata.domain)) {
    addError(errors, file, 'domain darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten.');
  }
  if (!RULE_TYPES.includes(metadata.rule_type)) {
    addError(errors, file, `rule_type hat einen unbekannten Wert: ${String(metadata.rule_type)}.`);
  }
  validateString(metadata.jurisdiction, 'jurisdiction', errors, file, 2);
  validateString(metadata.professional_owner_role, 'professional_owner_role', errors, file, 3);

  if (
    validateKnownKeys(metadata.validity, ['valid_from', 'valid_until'], 'validity', errors, file)
  ) {
    validateDate(metadata.validity.valid_from, 'validity.valid_from', errors, file);
    validateDate(metadata.validity.valid_until, 'validity.valid_until', errors, file);
    if (
      typeof metadata.validity.valid_from === 'string' &&
      typeof metadata.validity.valid_until === 'string' &&
      metadata.validity.valid_from > metadata.validity.valid_until
    ) {
      addError(errors, file, 'validity.valid_from darf nicht nach valid_until liegen.');
    }
  }

  if (
    validateKnownKeys(
      metadata.professional_review,
      ['status', 'reviewer', 'reviewed_at', 'reviewed_content_hash'],
      'professional_review',
      errors,
      file,
    )
  ) {
    const review = metadata.professional_review;
    if (!REVIEW_STATUSES.includes(review.status)) {
      addError(errors, file, `professional_review.status ist unbekannt: ${String(review.status)}.`);
    }
    if (review.reviewer !== null)
      validateString(review.reviewer, 'professional_review.reviewer', errors, file, 3);
    validateDate(review.reviewed_at, 'professional_review.reviewed_at', errors, file, {
      notFuture: true,
    });
    if (review.reviewed_content_hash !== null) {
      if (
        typeof review.reviewed_content_hash !== 'string' ||
        !REVIEW_HASH_PATTERN.test(review.reviewed_content_hash)
      ) {
        addError(
          errors,
          file,
          'professional_review.reviewed_content_hash muss sha256:<64 Kleinbuchstaben-Hexzeichen> oder null sein.',
        );
      }
    }
    if (review.status === 'approved' || review.status === 'superseded') {
      if (!review.reviewer || !review.reviewed_at || !review.reviewed_content_hash) {
        addError(
          errors,
          file,
          'Eine fachliche Freigabe oder abgelöste Freigabe braucht reviewer, reviewed_at und reviewed_content_hash.',
        );
      }
      if (
        !Array.isArray(metadata.sources) ||
        !metadata.sources.some((source) => source?.primary === true)
      ) {
        addError(
          errors,
          file,
          'Eine fachliche Freigabe braucht mindestens eine als primary markierte Quelle.',
        );
      }
    }
    if (
      ['unreviewed', 'in_review'].includes(review.status) &&
      review.reviewed_content_hash !== null
    ) {
      addError(
        errors,
        file,
        'Ein Entwurf oder laufender Review darf keinen reviewed_content_hash behaupten.',
      );
    }
    if (
      review.status === 'unreviewed' &&
      (review.reviewer !== null ||
        review.reviewed_at !== null ||
        review.reviewed_content_hash !== null)
    ) {
      addError(
        errors,
        file,
        'Ein ungeprüfter Entwurf darf keine Reviewidentität, kein Prüfdatum und keinen Inhaltshash behaupten.',
      );
    }
    if (review.status === 'superseded' && metadata.validity?.valid_until === null) {
      addError(errors, file, 'Eine abgelöste Regel braucht validity.valid_until.');
    }
  }

  if (
    validateKnownKeys(
      metadata.implementation,
      ['status', 'summary'],
      'implementation',
      errors,
      file,
    )
  ) {
    if (!IMPLEMENTATION_STATUSES.includes(metadata.implementation.status)) {
      addError(
        errors,
        file,
        `implementation.status ist unbekannt: ${String(metadata.implementation.status)}.`,
      );
    }
    validateString(metadata.implementation.summary, 'implementation.summary', errors, file, 10);
  }

  if (!Array.isArray(metadata.sources)) {
    addError(errors, file, 'sources muss eine Liste sein.');
  } else {
    if (metadata.sources.length === 0) {
      addError(errors, file, 'sources braucht mindestens eine nachvollziehbare Quelle.');
    }
    metadata.sources.forEach((source, index) =>
      validateSource(source, index, rootDir, errors, file),
    );
    const sourceKinds = new Set(metadata.sources.map((source) => source?.kind));
    if (metadata.rule_type === 'statute' && !sourceKinds.has('official_law')) {
      addError(errors, file, 'Eine gesetzliche Regel braucht mindestens eine Quelle official_law.');
    }
    if (metadata.rule_type === 'administrative_guidance' && !sourceKinds.has('official_guidance')) {
      addError(
        errors,
        file,
        'Eine Verwaltungsanweisung braucht mindestens eine Quelle official_guidance.',
      );
    }
    if (metadata.rule_type === 'technical_standard' && !sourceKinds.has('technical_standard')) {
      addError(
        errors,
        file,
        'Eine technische Standardregel braucht mindestens eine Quelle technical_standard.',
      );
    }
    const requiredPrimaryKind = REQUIRED_PRIMARY_KIND[metadata.rule_type];
    if (
      requiredPrimaryKind &&
      !metadata.sources.some(
        (source) => source?.kind === requiredPrimaryKind && source?.primary === true,
      )
    ) {
      addError(
        errors,
        file,
        `Eine Regel vom Typ ${metadata.rule_type} braucht eine Primärquelle ${requiredPrimaryKind}.`,
      );
    }
  }

  const resolvedReferences = new Map();
  for (const [key, nonempty] of [
    ['code_refs', false],
    ['test_refs', false],
    ['feature_refs', false],
    ['related_rules', false],
    ['tags', true],
  ]) {
    const values = validateStringArray(metadata[key], key, errors, file, { nonempty });
    if (key === 'tags') {
      values.forEach((tag, index) => validateString(tag, `tags[${index}]`, errors, file, 2));
    }
    if (['code_refs', 'test_refs', 'feature_refs'].includes(key)) {
      resolvedReferences.set(
        key,
        values
          .map((reference, index) =>
            assertRepositoryFile(rootDir, reference, `${key}[${index}]`, errors, file),
          )
          .filter(Boolean),
      );
    }
  }

  const evidencedImplementation = ['implemented', 'partial', 'deviates'].includes(
    metadata.implementation?.status,
  );
  if (evidencedImplementation) {
    if (!Array.isArray(metadata.code_refs) || metadata.code_refs.length === 0) {
      addError(
        errors,
        file,
        `„${metadata.implementation.status}“ braucht mindestens einen code_ref.`,
      );
    }
    if (!Array.isArray(metadata.test_refs) || metadata.test_refs.length === 0) {
      addError(
        errors,
        file,
        `„${metadata.implementation.status}“ braucht mindestens einen test_ref.`,
      );
    }
    for (const [index, reference] of (metadata.code_refs ?? []).entries()) {
      if (!CODE_REFERENCE_PATTERN.test(reference) || TEST_REFERENCE_PATTERN.test(reference)) {
        addError(
          errors,
          file,
          `code_refs[${index}] muss auf ausführungsnahe Software unter apps/, packages/ oder scripts/ beziehungsweise auf einen Workflow unter .forgejo/workflows/ zeigen.`,
        );
      }
    }
    for (const [index, reference] of (metadata.test_refs ?? []).entries()) {
      if (!TEST_REFERENCE_PATTERN.test(reference) || /\.d\.[cm]?[jt]sx?$/.test(reference)) {
        addError(
          errors,
          file,
          `test_refs[${index}] muss auf eine ausführbare Testdatei unter apps/, packages/ oder scripts/ zeigen.`,
        );
      }
    }
    const overlappingReferences = (metadata.code_refs ?? []).filter((reference) =>
      (metadata.test_refs ?? []).includes(reference),
    );
    if (overlappingReferences.length > 0) {
      addError(
        errors,
        file,
        `code_refs und test_refs müssen getrennte Dateien belegen: ${overlappingReferences.join(', ')}.`,
      );
    }
    const marker = `Fachkatalog: ${String(metadata.id)}`;
    const linkedTest = (resolvedReferences.get('test_refs') ?? []).some((testFile) =>
      readFileSync(testFile, 'utf8').includes(marker),
    );
    if (!linkedTest) {
      addError(errors, file, `Mindestens ein test_ref muss die Zuordnung „${marker}“ enthalten.`);
    }
  }

  if (typeof metadata.id === 'string') {
    const expectedPrefix = `${metadata.id.toLowerCase()}-`;
    if (!basename(relativeFile).startsWith(expectedPrefix)) {
      addError(errors, file, `Dateiname muss mit ${expectedPrefix} beginnen.`);
    }
  }
  const relativeParts = toPosix(relative(context.rulesDir, file)).split('/');
  if (relativeParts.length < 2 || relativeParts[0] !== metadata.domain) {
    addError(errors, file, `Regel muss unter regeln/${String(metadata.domain)}/ liegen.`);
  }
}

function validateBody(metadata, body, errors, file) {
  if (typeof metadata.id === 'string' && typeof metadata.title === 'string') {
    const expectedTitle = `# ${metadata.id} — ${metadata.title}`;
    const firstLine = body.trimStart().split(/\r?\n/, 1)[0];
    if (firstLine !== expectedTitle) {
      addError(errors, file, `Erste Überschrift muss exakt „${expectedTitle}“ lauten.`);
    }
  }
  const sections = levelTwoSections(body);
  const unknownHeadings = sections
    .map((section) => section.heading)
    .filter((heading) => !REQUIRED_HEADINGS.includes(heading));
  if (unknownHeadings.length > 0) {
    addError(
      errors,
      file,
      `Unbekannte Überschriften der Ebene 2: ${unknownHeadings.join(', ')}. Unterabschnitte müssen Ebene 3 verwenden.`,
    );
  }
  let previous = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const marker = `## ${heading}`;
    const matching = sections.filter((section) => section.heading === heading);
    if (matching.length === 0) {
      addError(errors, file, `Pflichtabschnitt „${marker}“ fehlt.`);
    } else if (matching.length > 1) {
      addError(errors, file, `Pflichtabschnitt „${marker}“ kommt mehrfach vor.`);
    } else if (matching[0].position < previous) {
      addError(errors, file, `Pflichtabschnitt „${marker}“ steht in falscher Reihenfolge.`);
    } else {
      previous = matching[0].position;
      if (matching[0].content.length < 10) {
        addError(errors, file, `Pflichtabschnitt „${marker}“ ist inhaltlich leer.`);
      }
    }
  }
  const summary = extractSummary(body);
  if (summary.length < 20) {
    addError(errors, file, 'Kurzfassung muss mindestens 20 Zeichen umfassen.');
  }
  if (['partial', 'deviates'].includes(metadata.implementation?.status)) {
    const deviations = extractSection(body, 'Bekannte Abweichungen und Grenzen');
    if (/^Keine\b/i.test(deviations) || deviations.length < 30) {
      addError(
        errors,
        file,
        'Bei partial/deviates muss die bekannte Abweichung konkret beschrieben sein.',
      );
    }
  }
  if (['approved', 'superseded'].includes(metadata.professional_review?.status)) {
    const recordedHash = metadata.professional_review.reviewed_content_hash;
    if (typeof recordedHash === 'string' && REVIEW_HASH_PATTERN.test(recordedHash)) {
      const expectedHash = reviewContentHash(metadata, body);
      if (recordedHash !== expectedHash) {
        addError(
          errors,
          file,
          'Der fachlich geprüfte Inhalt wurde nach der Freigabe verändert; Status zurücksetzen und neu prüfen.',
        );
      }
    }
  }
  return summary;
}

export function loadCatalog(rootDir = process.cwd()) {
  const normalizedRoot = resolve(rootDir);
  const rulesDir = safeRepositoryDirectory(normalizedRoot, 'docs/fachkatalog/regeln');
  const files = walkMarkdown(rulesDir);
  const errors = [];
  const rules = [];

  if (files.length === 0) {
    throw new Error(`Keine Fachregeln unter ${rulesDir} gefunden.`);
  }

  for (const file of files) {
    const relativeFile = toPosix(relative(normalizedRoot, file));
    let parsed;
    try {
      parsed = parseRuleSource(readFileSync(file, 'utf8'), relativeFile);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    validateMetadata(parsed.metadata, {
      rootDir: normalizedRoot,
      rulesDir,
      file,
      relativeFile,
      errors,
    });
    const summary = validateBody(parsed.metadata, parsed.body, errors, relativeFile);
    rules.push({
      ...parsed.metadata,
      path: relativeFile,
      summary,
      body: parsed.body,
    });
  }

  const byId = new Map();
  for (const rule of rules) {
    if (byId.has(rule.id)) {
      addError(errors, rule.path, `Regel-ID ist doppelt; zuerst in ${byId.get(rule.id).path}.`);
    } else {
      byId.set(rule.id, rule);
    }
  }
  for (const rule of rules) {
    for (const relatedId of Array.isArray(rule.related_rules) ? rule.related_rules : []) {
      if (relatedId === rule.id)
        addError(errors, rule.path, 'related_rules darf nicht auf die Regel selbst zeigen.');
      if (!byId.has(relatedId))
        addError(errors, rule.path, `related_rules verweist auf unbekannte ID ${relatedId}.`);
    }
    if (
      rule.professional_review?.status === 'superseded' &&
      (!rule.related_rules || rule.related_rules.length === 0)
    ) {
      addError(
        errors,
        rule.path,
        'Eine abgelöste Regel braucht mindestens eine Nachfolgeregel in related_rules.',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Fachkatalog ist ungültig (${errors.length} Befund${errors.length === 1 ? '' : 'e'}):\n- ${errors.join('\n- ')}`,
    );
  }

  return rules.sort((left, right) => left.id.localeCompare(right.id, 'de'));
}

export function assertScopeCoverage(rootDir, rules) {
  if (!Array.isArray(rules)) {
    throw new TypeError('rules muss eine Liste validierter Fachregeln sein.');
  }

  const errors = [];
  const scopeFile = assertRepositoryFile(
    rootDir,
    SCOPE_DEFINITION_PATH,
    'Scope-Definition',
    errors,
    SCOPE_DEFINITION_PATH,
  );
  if (!scopeFile) {
    throw new Error(`Fachkatalog-Scope ist ungültig:\n- ${errors.join('\n- ')}`);
  }

  const source = readFileSync(scopeFile, 'utf8');
  const scopeManifestMatches = [
    ...source.matchAll(
      /<!--\s*fachkatalog-scope:\s*version=(\d+);\s*active=(\d+);\s*reserved=(\d+)\s*-->/g,
    ),
  ];
  if (scopeManifestMatches.length !== 1) {
    throw new Error(
      `${SCOPE_DEFINITION_PATH}: genau ein Maschinenmarker „fachkatalog-scope: version=…; active=…; reserved=…“ ist erforderlich.`,
    );
  }
  const [, manifestVersionText, expectedActiveText, expectedReservedText] = scopeManifestMatches[0];
  const manifestVersion = Number(manifestVersionText);
  const expectedActiveRuleCount = Number(expectedActiveText);
  const expectedReservedRuleCount = Number(expectedReservedText);
  if (manifestVersion !== 1) {
    throw new Error(
      `${SCOPE_DEFINITION_PATH}: unbekannte Scope-Manifestversion ${manifestVersion}.`,
    );
  }

  const excludedSection = source.search(/^## 8\./m);
  const prioritizationSection = source.search(/^## 9\./m);
  if (
    excludedSection === -1 ||
    prioritizationSection === -1 ||
    prioritizationSection <= excludedSection
  ) {
    throw new Error(
      `${SCOPE_DEFINITION_PATH}: geordnete Abschnitte „## 8.“ (Ausschlüsse) und „## 9.“ (Ausbau) fehlen.`,
    );
  }

  const extractIds = (text) =>
    [...text.matchAll(/`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d{3})`/g)].map((match) => match[1]);
  const scopedIds = extractIds(source.slice(0, excludedSection));
  const reservedIds = extractIds(source.slice(excludedSection, prioritizationSection));
  if (scopedIds.length === 0) {
    throw new Error(`${SCOPE_DEFINITION_PATH}: Vor Abschnitt 8 sind keine Regel-IDs definiert.`);
  }

  const countIds = (ids) => {
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  };
  const scopeCounts = countIds(scopedIds);
  const reservedCounts = countIds(reservedIds);
  const duplicateScopedIds = [...scopeCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right, 'de'));
  const duplicateReservedIds = [...reservedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right, 'de'));
  const uniqueScopedIds = new Set(scopeCounts.keys());
  const uniqueReservedIds = new Set(reservedCounts.keys());
  const catalogIds = new Set(rules.map((rule) => rule.id));
  const activeCatalogIds = new Set(
    rules
      .filter((rule) => rule.professional_review?.status !== 'superseded')
      .map((rule) => rule.id),
  );
  const missing = [...uniqueScopedIds]
    .filter((id) => !activeCatalogIds.has(id))
    .sort((left, right) => left.localeCompare(right, 'de'));
  const outsideScope = [...activeCatalogIds]
    .filter((id) => !uniqueScopedIds.has(id))
    .sort((left, right) => left.localeCompare(right, 'de'));
  const reservedInCatalog = [...catalogIds]
    .filter((id) => uniqueReservedIds.has(id))
    .sort((left, right) => left.localeCompare(right, 'de'));

  const findings = [];
  if (duplicateScopedIds.length > 0) {
    findings.push(`IDs mehrfach vor Abschnitt 8 genannt: ${duplicateScopedIds.join(', ')}.`);
  }
  if (duplicateReservedIds.length > 0) {
    findings.push(
      `reservierte IDs mehrfach in Abschnitt 8 genannt: ${duplicateReservedIds.join(', ')}.`,
    );
  }
  if (uniqueScopedIds.size !== expectedActiveRuleCount) {
    findings.push(
      `Scope-Marker erwartet ${expectedActiveRuleCount} aktive IDs, gefunden wurden ${uniqueScopedIds.size}.`,
    );
  }
  if (uniqueReservedIds.size !== expectedReservedRuleCount) {
    findings.push(
      `Scope-Marker erwartet ${expectedReservedRuleCount} reservierte IDs, gefunden wurden ${uniqueReservedIds.size}.`,
    );
  }
  if (missing.length > 0) {
    findings.push(`aktive Regeldateien für in-scope IDs fehlen: ${missing.join(', ')}.`);
  }
  if (outsideScope.length > 0) {
    findings.push(
      `aktive Regel-IDs sind nicht im Produkt-Scope erfasst: ${outsideScope.join(', ')}.`,
    );
  }
  if (reservedInCatalog.length > 0) {
    findings.push(
      `reservierte IDs dürfen keine Regeldatei besitzen: ${reservedInCatalog.join(', ')}.`,
    );
  }
  if (findings.length > 0) {
    throw new Error(
      `Fachkatalog-Scope ist unvollständig (${findings.length} Befunde):\n- ${findings.join('\n- ')}`,
    );
  }

  return {
    manifest_version: manifestVersion,
    definition_path: SCOPE_DEFINITION_PATH,
    definition_sha256: `sha256:${createHash('sha256')
      .update(source.replace(/\r\n?/g, '\n'), 'utf8')
      .digest('hex')}`,
    expected_active_rule_count: expectedActiveRuleCount,
    expected_reserved_rule_count: expectedReservedRuleCount,
    active_rule_ids: [...uniqueScopedIds].sort((left, right) => left.localeCompare(right, 'de')),
    reserved_rule_ids: [...uniqueReservedIds].sort((left, right) =>
      left.localeCompare(right, 'de'),
    ),
    definition_markdown: source.replace(/\r\n?/g, '\n'),
    completeness:
      'Vollständig nur für die als aktiv bezeichnete Produktlogik; keine Vollständigkeit eines Rechtsgebiets und keine fachliche Freigabe.',
  };
}

function periodLabel(validity) {
  if (!validity.valid_from && !validity.valid_until) return 'nicht eingegrenzt';
  if (validity.valid_from && validity.valid_until)
    return `${validity.valid_from} bis ${validity.valid_until}`;
  if (validity.valid_from) return `ab ${validity.valid_from}`;
  return `bis ${validity.valid_until}`;
}

const FALLBACK_EXPORT_SCOPE = {
  definition_path: SCOPE_DEFINITION_PATH,
  completeness:
    'Vollständig nur für die dort als in scope bezeichnete Produktlogik; keine Vollständigkeit eines Rechtsgebiets und keine fachliche Freigabe.',
};

function sortedRules(rules) {
  return [...rules].sort((left, right) => left.id.localeCompare(right.id, 'de'));
}

function exportCounts(rules) {
  const activeRuleCount = rules.filter(
    (rule) => rule.professional_review?.status !== 'superseded',
  ).length;
  return {
    rule_count: rules.length,
    active_rule_count: activeRuleCount,
    historical_rule_count: rules.length - activeRuleCount,
  };
}

export function renderMarkdownIndex(rules) {
  const groups = new Map();
  for (const rule of sortedRules(rules)) {
    if (!groups.has(rule.domain)) groups.set(rule.domain, []);
    groups.get(rule.domain).push(rule);
  }
  const lines = [
    '# Fachkatalog – Regelindex',
    '',
    '<!-- Diese Datei wird durch `pnpm fachkatalog:generate` erzeugt. Nicht manuell bearbeiten. -->',
    '',
    '> Der fachliche Status und der technische Umsetzungsstand sind unabhängig.',
    '> „Umgesetzt“ bedeutet nicht „fachlich freigegeben“.',
    '> `approved` authentifiziert die eingetragene Person nur mit separater Repository-Governance oder signierter Attestation.',
    '',
  ];
  for (const domain of [...groups.keys()].sort((left, right) => left.localeCompare(right, 'de'))) {
    lines.push(`## ${DOMAIN_LABELS[domain] ?? domain}`, '');
    for (const rule of groups.get(domain)) {
      const link = rule.path.replace(/^docs\/fachkatalog\//, '');
      lines.push(
        `### [${rule.id} — ${rule.title}](${link})`,
        '',
        `- Fachprüfung: **${REVIEW_LABELS[rule.professional_review.status]}**`,
        `- Umsetzung: **${IMPLEMENTATION_LABELS[rule.implementation.status]}**`,
        `- Geltung: ${periodLabel(rule.validity)}`,
        `- Kurzfassung: ${rule.summary}`,
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function renderJsonIndex(rules, scope = FALLBACK_EXPORT_SCOPE) {
  const orderedRules = sortedRules(rules);
  const compactScope = { ...scope };
  delete compactScope.definition_markdown;
  const serializable = orderedRules.map((rule) => {
    const indexEntry = { ...rule };
    delete indexEntry.body;
    return indexEntry;
  });
  const source = JSON.stringify({
    schema_version: 1,
    purpose:
      'Such- und Gegenprüfindex für TaxTronik-Fachregeln; vollständige Regeldatei vor Änderungen lesen.',
    scope: compactScope,
    ...exportCounts(orderedRules),
    warning:
      'Fachliche Freigabe und technischer Umsetzungsstand sind getrennt. approved authentifiziert ohne Repository-Governance oder signierte Attestation keine Person; KI darf keine fachliche Freigabe erteilen.',
    rules: serializable,
  });
  return formatWithPrettier(source, {
    parser: 'json',
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
}

export async function renderFullJsonExport(rules, scope = FALLBACK_EXPORT_SCOPE) {
  const normalizedRules = sortedRules(rules).map((rule) => ({
    ...rule,
    body: typeof rule.body === 'string' ? rule.body.replace(/\r\n?/g, '\n') : rule.body,
  }));
  const source = JSON.stringify({
    schema_version: 1,
    purpose:
      'Vollständiger Maschinenexport aller TaxTronik-Fachregeln einschließlich Markdown-Regeltext.',
    scope,
    ...exportCounts(normalizedRules),
    warning:
      'Fachliche Freigabe und technischer Umsetzungsstand sind getrennt. approved authentifiziert ohne Repository-Governance oder signierte Attestation keine Person; KI darf keine fachliche Freigabe erteilen.',
    rules: normalizedRules,
  });
  return formatWithPrettier(source, {
    parser: 'json',
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
}

export async function expectedIndexes(rules, scope = FALLBACK_EXPORT_SCOPE) {
  return {
    markdown: renderMarkdownIndex(rules),
    json: await renderJsonIndex(rules, scope),
    fullJson: await renderFullJsonExport(rules, scope),
  };
}

function safeIndexTarget(rootDir, name) {
  const root = realpathSync(resolve(rootDir));
  const directory = safeRepositoryDirectory(root, 'docs/fachkatalog');
  const target = join(directory, name);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`${name} darf kein symbolischer Link sein.`);
    }
    const actualTarget = realpathSync(target);
    const targetFromRoot = relative(root, actualTarget);
    if (targetFromRoot.startsWith('..') || isAbsolute(targetFromRoot)) {
      throw new Error(`${name} darf das Repository nicht verlassen.`);
    }
  }
  return target;
}

function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function writeIndexes(rootDir, rules) {
  const scope = assertScopeCoverage(rootDir, rules);
  const expected = await expectedIndexes(rules, scope);
  atomicWrite(safeIndexTarget(rootDir, 'INDEX.md'), expected.markdown);
  atomicWrite(safeIndexTarget(rootDir, 'fachkatalog.json'), expected.json);
  atomicWrite(safeIndexTarget(rootDir, 'fachkatalog-voll.json'), expected.fullJson);
}

function normalizeLineEndings(source) {
  return source.replace(/\r\n?/g, '\n');
}

export async function checkIndexes(rootDir, rules) {
  const scope = assertScopeCoverage(rootDir, rules);
  const expected = await expectedIndexes(rules, scope);
  const findings = [];
  for (const [name, content] of [
    ['INDEX.md', expected.markdown],
    ['fachkatalog.json', expected.json],
    ['fachkatalog-voll.json', expected.fullJson],
  ]) {
    const target = safeIndexTarget(rootDir, name);
    if (!existsSync(target)) {
      findings.push(`${name} fehlt.`);
      continue;
    }
    if (normalizeLineEndings(readFileSync(target, 'utf8')) !== normalizeLineEndings(content)) {
      findings.push(`${name} ist nicht aktuell.`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`${findings.join(' ')} Bitte „pnpm fachkatalog:generate“ ausführen.`);
  }
  return true;
}
