// Fachkatalog: ASSURANCE-PROFESSIONAL-REVIEW-001
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertScopeCoverage,
  checkIndexes,
  extractSection,
  IMPLEMENTATION_STATUSES,
  latestPlausibleCalendarDate,
  loadCatalog,
  parseRuleSource,
  REVIEW_STATUSES,
  reviewContentHash,
  RULE_TYPES,
  renderFullJsonExport,
  renderJsonIndex,
  SOURCE_KINDS,
  writeIndexes,
} from '../fachkatalog/lib.mjs';
import {
  evaluateCatalogDiff,
  isFachPath,
  parseExceptionLedger,
  parseNameStatus,
} from '../fachkatalog/diff-guard.mjs';

const HEADINGS = [
  ['Kurzfassung', 'Diese Regel beschreibt einen eindeutig prüfbaren Normalfall.'],
  ['Wann gilt die Regel?', 'Sie gilt für den abgegrenzten Testfall.'],
  ['Benötigte Angaben', '- Eingabe A\n- Eingabe B'],
  ['Entscheidungslogik', '| Wenn | Dann |\n| --- | --- |\n| A | B |'],
  ['Ausnahmen und Grenzfälle', 'Sonderfälle werden manuell geprüft.'],
  ['Beispiele', '### Normalfall\n\nAus A folgt B.'],
  ['Umsetzung in TaxTronik', 'Die Anwendung setzt den beschriebenen Fall um.'],
  [
    'Bekannte Abweichungen und Grenzen',
    'Keine bekannten Abweichungen innerhalb des engen Test-Scopes.',
  ],
  ['Fachliche Prüffragen', '- Ist die Abgrenzung fachlich richtig?'],
  ['Technische Nachweise', 'Die Fixture-Dateien belegen Code und Test.'],
];

function scopeSource({
  activeIds = ['TEST-RULE-001'],
  reservedIds = ['RESERVED-RULE-001'],
  expectedActive = activeIds.length,
  expectedReserved = reservedIds.length,
} = {}) {
  return `# Test-Scope

<!-- fachkatalog-scope: version=1; active=${expectedActive}; reserved=${expectedReserved} -->

${activeIds.map((id) => `\`${id}\``).join('\n')}

## 8. Ausschlüsse

${reservedIds.map((id) => `\`${id}\``).join('\n')}

## 9. Ausbau
`;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'taxtronik-fachkatalog-'));
  mkdirSync(join(root, 'docs', 'fachkatalog', 'regeln', 'testbereich'), { recursive: true });
  mkdirSync(join(root, 'packages', 'example', 'src', '__tests__'), { recursive: true });
  writeFileSync(join(root, 'FEATURES.md'), '# Features\n', 'utf8');
  writeFileSync(join(root, 'docs', 'fachkatalog', 'SCOPE.md'), scopeSource(), 'utf8');
  writeFileSync(
    join(root, 'packages', 'example', 'src', 'rule.ts'),
    'export const rule = true;\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'packages', 'example', 'src', '__tests__', 'rule.test.ts'),
    '// Fachkatalog: TEST-RULE-001\nvoid 0;\n',
    'utf8',
  );
  return root;
}

function ruleSource({
  id = 'TEST-RULE-001',
  review = 'unreviewed',
  reviewer = 'null',
  reviewedAt = 'null',
  codeRef = 'packages/example/src/rule.ts',
  testRef = 'packages/example/src/__tests__/rule.test.ts',
} = {}) {
  const body = HEADINGS.map(([heading, content]) => `## ${heading}\n\n${content}`).join('\n\n');
  return `---
id: ${id}
title: Prüffähige Testregel
domain: testbereich
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Test
professional_review:
  status: ${review}
  reviewer: ${reviewer}
  reviewed_at: ${reviewedAt}
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Die Testimplementierung entspricht dem beschriebenen Scope.
sources:
  - kind: product_documentation
    citation: Interne Feature-Dokumentation
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true
code_refs:
  - ${codeRef}
test_refs:
  - ${testRef}
feature_refs:
  - FEATURES.md
related_rules: []
tags:
  - test
---
# ${id} — Prüffähige Testregel

${body}
`;
}

function writeRule(root, source, fileName = 'test-rule-001-test.md') {
  writeFileSync(
    join(root, 'docs', 'fachkatalog', 'regeln', 'testbereich', fileName),
    source,
    'utf8',
  );
}

test('liest und validiert eine vollständige Regel', async () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    const rules = loadCatalog(root);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].summary, 'Diese Regel beschreibt einen eindeutig prüfbaren Normalfall.');
    assert.match(await renderJsonIndex(rules), /"professional_review"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verhindert eine behauptete Freigabe ohne Reviewer und Prüfdatum', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource({ review: 'approved' }));
    assert.throws(
      () => loadCatalog(root),
      /Freigabe.*reviewer, reviewed_at und reviewed_content_hash/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindet eine Freigabe an den tatsächlich geprüften Regelinhalt', () => {
  const root = makeRoot();
  try {
    const draft = ruleSource();
    const parsed = parseRuleSource(draft);
    const hash = reviewContentHash(parsed.metadata, parsed.body);
    const approved = draft
      .replace('status: unreviewed', 'status: approved')
      .replace('reviewer: null', 'reviewer: Dr. Fachlich')
      .replace('reviewed_at: null', "reviewed_at: '2026-08-23'")
      .replace('reviewed_content_hash: null', `reviewed_content_hash: ${hash}`);
    writeRule(root, approved);
    assert.equal(loadCatalog(root).length, 1);

    writeRule(
      root,
      approved.replace('eindeutig prüfbaren Normalfall', 'nachträglich veränderten Fall'),
    );
    assert.throws(() => loadCatalog(root), /nach der Freigabe verändert/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verhindert tote oder falsch geschriebene lokale Nachweise', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource({ codeRef: 'src/Rule.ts' }));
    assert.throws(() => loadCatalog(root), /exakter Groß-\/Kleinschreibung/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('erkennt doppelte Regel-IDs', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    writeRule(root, ruleSource(), 'test-rule-001-zweite.md');
    assert.throws(() => loadCatalog(root), /Regel-ID ist doppelt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('erzeugt deterministische Indizes und erkennt Drift', async () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    const rules = loadCatalog(root);
    await writeIndexes(root, rules);
    assert.equal(await checkIndexes(root, rules), true);
    const fullExport = JSON.parse(
      readFileSync(join(root, 'docs', 'fachkatalog', 'fachkatalog-voll.json'), 'utf8'),
    );
    assert.equal(fullExport.scope.definition_path, 'docs/fachkatalog/SCOPE.md');
    assert.equal(fullExport.scope.expected_active_rule_count, 1);
    assert.deepEqual(fullExport.scope.active_rule_ids, ['TEST-RULE-001']);
    assert.deepEqual(fullExport.scope.reserved_rule_ids, ['RESERVED-RULE-001']);
    assert.match(fullExport.scope.definition_markdown, /## 8\. Ausschlüsse/);
    const compactExport = JSON.parse(
      readFileSync(join(root, 'docs', 'fachkatalog', 'fachkatalog.json'), 'utf8'),
    );
    assert.equal(compactExport.scope.definition_markdown, undefined);
    assert.equal(fullExport.rule_count, fullExport.rules.length);
    assert.equal(fullExport.active_rule_count, 1);
    assert.equal(fullExport.historical_rule_count, 0);
    assert.match(fullExport.rules[0].body, /## Entscheidungslogik/);
    writeFileSync(join(root, 'docs', 'fachkatalog', 'INDEX.md'), '# veraltet\n', 'utf8');
    await assert.rejects(() => checkIndexes(root, rules), /INDEX.md ist nicht aktuell/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalisiert Zeilenenden im Volltext-Export plattformunabhängig', async () => {
  const exported = JSON.parse(
    await renderFullJsonExport([{ id: 'TEST-RULE-001', body: 'A\r\nB\rC' }]),
  );
  assert.equal(exported.rules[0].body, 'A\nB\nC');
});

test('sortiert direkte Renderer-Aufrufe und weist aktive sowie historische Regeln aus', async () => {
  const exported = JSON.parse(
    await renderJsonIndex([
      { id: 'TEST-RULE-002', professional_review: { status: 'superseded' } },
      { id: 'TEST-RULE-001', professional_review: { status: 'unreviewed' } },
    ]),
  );
  assert.deepEqual(
    exported.rules.map((rule) => rule.id),
    ['TEST-RULE-001', 'TEST-RULE-002'],
  );
  assert.equal(exported.rule_count, 2);
  assert.equal(exported.active_rule_count, 1);
  assert.equal(exported.historical_rule_count, 1);
});

test('verhindert unvollständige oder gegenüber dem Scope überzählige Exporte', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    const rules = loadCatalog(root);
    assert.deepEqual(assertScopeCoverage(root, rules).active_rule_ids, ['TEST-RULE-001']);
    assert.throws(
      () =>
        assertScopeCoverage(
          root,
          rules.map((rule) => ({
            ...rule,
            professional_review: { ...rule.professional_review, status: 'superseded' },
          })),
        ),
      /aktive Regeldateien.*TEST-RULE-001/s,
    );

    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      scopeSource({ activeIds: ['TEST-RULE-001', 'TEST-RULE-002'] }),
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /TEST-RULE-002/);

    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      scopeSource({ activeIds: ['TEST-RULE-002'] }),
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /nicht im Produkt-Scope.*TEST-RULE-001/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verhindert doppelte Scope-IDs und eine fehlende Ausschlussgrenze', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    const rules = loadCatalog(root);
    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      scopeSource({ activeIds: ['TEST-RULE-001', 'TEST-RULE-001'], expectedActive: 1 }),
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /mehrfach.*TEST-RULE-001/s);

    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      '# Test-Scope\n\n<!-- fachkatalog-scope: version=1; active=1; reserved=1 -->\n\n`TEST-RULE-001`\n',
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /Abschnitte „## 8\.“.*„## 9\.“/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindet Sollzahlen und reservierte IDs maschinell', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource());
    const rules = loadCatalog(root);

    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      scopeSource({ expectedActive: 2 }),
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /erwartet 2 aktive IDs/);

    writeFileSync(
      join(root, 'docs', 'fachkatalog', 'SCOPE.md'),
      scopeSource({ reservedIds: ['TEST-RULE-001'] }),
      'utf8',
    );
    assert.throws(() => assertScopeCoverage(root, rules), /reservierte IDs.*TEST-RULE-001/s);

    writeFileSync(join(root, 'docs', 'fachkatalog', 'SCOPE.md'), scopeSource(), 'utf8');
    assert.throws(
      () =>
        assertScopeCoverage(root, [
          ...rules,
          { id: 'RESERVED-RULE-001', professional_review: { status: 'superseded' } },
        ]),
      /reservierte IDs.*RESERVED-RULE-001/s,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('meldet ungültiges Frontmatter verständlich', () => {
  assert.throws(() => parseRuleSource('kein Frontmatter', 'regel.md'), /YAML-Frontmatter/);
});

test('akzeptiert Pflichtüberschriften nur als exakte Ebene-2-Abschnitte', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource().replace('## Kurzfassung', '## Kurzfassung mit Zusatz'));
    assert.throws(() => loadCatalog(root), /Pflichtabschnitt „## Kurzfassung“ fehlt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignoriert vorgetäuschte Pflichtüberschriften in Markdown-Codeblöcken', () => {
  const fenced = '```markdown\n## Kurzfassung\nNur ein Beispiel, kein Abschnitt.\n```\n';
  assert.equal(extractSection(fenced, 'Kurzfassung'), '');
});

test('verhindert Prüf- und Quelldaten in der Zukunft', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource().replace("checked_at: '2026-08-23'", "checked_at: '2999-01-01'"));
    assert.throws(() => loadCatalog(root), /darf nicht in der Zukunft liegen/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verwendet den deutschen Kalendertag an UTC-Tagesgrenzen', () => {
  assert.equal(latestPlausibleCalendarDate(new Date('2026-08-23T22:30:00.000Z')), '2026-08-24');
  assert.equal(latestPlausibleCalendarDate(new Date('2026-08-24T10:00:00.000Z')), '2026-08-24');
});

test('verhindert interne Dateien als angeblich amtliche Quelle', () => {
  const root = makeRoot();
  try {
    writeRule(root, ruleSource().replace('kind: product_documentation', 'kind: official_law'));
    assert.throws(() => loadCatalog(root), /kind official_law braucht url/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('akzeptiert amtliche Quellen nur von freigegebenen Domains', () => {
  const root = makeRoot();
  try {
    const source = ruleSource()
      .replace('rule_type: product_rule', 'rule_type: statute')
      .replace('kind: product_documentation', 'kind: official_law')
      .replace('path: FEATURES.md', 'url: https://evil.example/ao');
    writeRule(root, source);
    assert.throws(() => loadCatalog(root), /keine freigegebene amtliche Domain/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('akzeptiert amtliche Landesverwaltungsvorschriften vom freigegebenen Host', () => {
  const root = makeRoot();
  try {
    const source = ruleSource()
      .replace('kind: product_documentation', 'kind: official_guidance')
      .replace(
        'path: FEATURES.md',
        'url: https://bravors.brandenburg.de/verwaltungsvorschriften/feiertagsrecht',
      );
    writeRule(root, source);
    assert.doesNotThrow(() => loadCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verlangt bei Freigabe eine zum Regeltyp passende Primärquelle', () => {
  const root = makeRoot();
  try {
    const draft = ruleSource()
      .replace('rule_type: product_rule', 'rule_type: statute')
      .replace(
        `sources:
  - kind: product_documentation
    citation: Interne Feature-Dokumentation
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true`,
        `sources:
  - kind: official_law
    citation: Testgesetz
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: false
  - kind: product_documentation
    citation: Interne Feature-Dokumentation
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true`,
      );
    const parsed = parseRuleSource(draft);
    const hash = reviewContentHash(parsed.metadata, parsed.body);
    const approved = draft
      .replace('status: unreviewed', 'status: approved')
      .replace('reviewer: null', 'reviewer: Dr. Fachlich')
      .replace('reviewed_at: null', "reviewed_at: '2026-08-23'")
      .replace('reviewed_content_hash: null', `reviewed_content_hash: ${hash}`);
    writeRule(root, approved);
    assert.throws(() => loadCatalog(root), /Primärquelle official_law/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('weist Dokumente als Code- oder Testnachweis zurück', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, 'docs', '__tests__'), { recursive: true });
    writeFileSync(
      join(root, 'docs', '__tests__', 'beleg.md'),
      '// Fachkatalog: TEST-RULE-001\n',
      'utf8',
    );
    writeRule(root, ruleSource({ codeRef: 'FEATURES.md', testRef: 'docs/__tests__/beleg.md' }));
    assert.throws(() => loadCatalog(root), /ausführungsnahe Software.*ausführbare Testdatei/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('akzeptiert ausführbare Skripte, Skripttests und Forgejo-Workflows als Nachweise', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, 'scripts', 'release', 'tests'), { recursive: true });
    mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'release', 'gate.mjs'), 'export const gate = true;\n');
    writeFileSync(
      join(root, 'scripts', 'release', 'tests', 'gate.test.mjs'),
      '// Fachkatalog: TEST-RULE-001\nvoid 0;\n',
    );
    writeFileSync(join(root, '.forgejo', 'workflows', 'release.yml'), 'name: release\n');

    writeRule(
      root,
      ruleSource({
        codeRef: 'scripts/release/gate.mjs',
        testRef: 'scripts/release/tests/gate.test.mjs',
      }),
    );
    assert.doesNotThrow(() => loadCatalog(root));

    writeRule(
      root,
      ruleSource({
        codeRef: '.forgejo/workflows/release.yml',
        testRef: 'scripts/release/tests/gate.test.mjs',
      }),
    );
    assert.doesNotThrow(() => loadCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trennt Implementierungs- und Testnachweise', () => {
  const root = makeRoot();
  try {
    const testPath = 'packages/example/src/__tests__/rule.test.ts';
    writeRule(root, ruleSource({ codeRef: testPath, testRef: testPath }));
    assert.throws(() => loadCatalog(root), /code_refs und test_refs müssen getrennte Dateien/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hält Schema und Validator-Enums synchron', () => {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'docs', 'fachkatalog', 'schema', 'regel.schema.json'), 'utf8'),
  );
  assert.deepEqual(schema.properties.rule_type.enum, RULE_TYPES);
  assert.deepEqual(schema.properties.professional_review.properties.status.enum, REVIEW_STATUSES);
  assert.deepEqual(
    schema.properties.implementation.properties.status.enum,
    IMPLEMENTATION_STATUSES,
  );
  assert.deepEqual(schema.$defs.source.properties.kind.enum, SOURCE_KINDS);
});

test('fordert für Änderungen an Fachpfaden eine Regel oder dokumentierte Ausnahme', () => {
  const fachPath = 'packages/tax/src/engine.ts';
  assert.equal(isFachPath(fachPath), true);
  assert.equal(isFachPath('packages/db/prisma/schema.prisma'), true);
  assert.equal(isFachPath('packages/db/prisma/migrations/neutraler-name/migration.sql'), true);
  assert.equal(isFachPath('apps/web/src/server/gwg/verification.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/dsgvo/client-retention.ts'), true);
  assert.equal(isFachPath('packages/storage/src/service.ts'), true);
  assert.equal(isFachPath('packages/evidence/src/chain.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/poa/signing-snapshot.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/auth/rbac.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/settings/access-policy.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/bwa/tax-estimator.ts'), true);
  assert.equal(isFachPath('apps/web/src/server/risk/los.ts'), true);
  assert.equal(isFachPath('packages/db/src/staff-client-access.ts'), true);
  assert.equal(isFachPath('apps/web/src/app/portal/(protected)/forms/[id]/actions.ts'), true);
  assert.equal(isFachPath('.forgejo/workflows/release.yml'), true);
  assert.match(evaluateCatalogDiff([{ status: 'M', path: fachPath }]).findings[0], /Fachpfade/);
  assert.deepEqual(
    evaluateCatalogDiff(
      [
        { status: 'M', path: fachPath },
        {
          status: 'M',
          path: 'docs/fachkatalog/regeln/fristen-und-bescheide/tax-rule-001-test.md',
        },
      ],
      { documentedFachPaths: [fachPath] },
    ).findings,
    [],
  );
  assert.deepEqual(
    evaluateCatalogDiff(
      [
        { status: 'M', path: fachPath },
        { status: 'M', path: 'docs/fachkatalog/AENDERUNGEN.md' },
      ],
      { newExceptionPaths: [fachPath] },
    ).findings,
    [],
  );
});

test('eine beliebige Katalogänderung schaltet fremde Fachpfade nicht frei', () => {
  const result = evaluateCatalogDiff([
    { status: 'M', path: 'packages/tax/src/engine.ts' },
    {
      status: 'M',
      path: 'docs/fachkatalog/regeln/rechnungen/inv-rule-001-test.md',
    },
  ]);
  assert.match(result.findings[0], /keiner geänderten Regel/);
});

test('überwacht jeden katalogisierten Codepfad auch außerhalb statischer Präfixe', () => {
  const catalogPath = 'apps/web/src/app/staff/(protected)/beispiel/fach-action.ts';
  const result = evaluateCatalogDiff([{ status: 'M', path: catalogPath }], {
    catalogFachPaths: [catalogPath],
  });
  assert.deepEqual(result.fachChanges, [catalogPath]);
  assert.match(result.findings[0], /keiner geänderten Regel/);
});

test('verlangt strukturierte und plausible Ausnahmedatensätze', () => {
  const valid = `---
exceptions:
  - id: FK-EXC-20260823-001
    date: '2026-08-23'
    paths:
      - packages/tax/src/engine.ts
    rule_ids:
      - TAX-DEADLINE-WORKDAY-001
    reason: Diese Umbenennung verändert die fachliche Entscheidung nachweislich nicht.
    tests:
      - packages/tax/src/__tests__/engine.test.ts
    reviewer: Dr. Fachlich
---
# Ausnahmen
`;
  assert.equal(parseExceptionLedger(valid).length, 1);
  assert.throws(
    () => parseExceptionLedger(valid.replace('packages/tax/src/engine.ts', 'README.md')),
    /nur überwachte Fachpfade/,
  );
});

test('verbietet das Löschen historischer Fachregeln und versteht Git-Renames', () => {
  const deleted = evaluateCatalogDiff([
    {
      status: 'D',
      path: 'docs/fachkatalog/regeln/rechnungen/inv-rule-001-alt.md',
    },
  ]);
  assert.match(deleted.findings[0], /nicht gelöscht/);
  assert.deepEqual(parseNameStatus('R100\0alt.ts\0neu.ts\0'), [
    { status: 'R100', oldPath: 'alt.ts', path: 'neu.ts' },
  ]);
  assert.deepEqual(parseNameStatus('M\0packages/tax/src/prüfung.ts\0'), [
    { status: 'M', path: 'packages/tax/src/prüfung.ts' },
  ]);

  const movedOutsideCatalog = evaluateCatalogDiff([
    {
      status: 'R100',
      oldPath: 'docs/fachkatalog/regeln/rechnungen/inv-rule-001-alt.md',
      path: 'docs/archiv/inv-rule-001-alt.md',
    },
  ]);
  assert.match(movedOutsideCatalog.findings[0], /nicht gelöscht/);

  const movedOutsideFachPath = evaluateCatalogDiff([
    {
      status: 'R100',
      oldPath: 'packages/tax/src/engine.ts',
      path: 'packages/shared/src/engine.ts',
    },
  ]);
  assert.match(movedOutsideFachPath.findings[0], /Fachpfade/);

  const replacedId = evaluateCatalogDiff(
    [
      {
        status: 'M',
        path: 'docs/fachkatalog/regeln/rechnungen/inv-rule-001-alt.md',
      },
    ],
    { baseRuleIds: ['INV-RULE-001'], headRuleIds: ['INV-RULE-002'] },
  );
  assert.match(replacedId.findings[0], /Historische Regel-IDs/);
});
