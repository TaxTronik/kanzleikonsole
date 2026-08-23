#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { assertRepositoryFile, loadCatalog, parseRuleSource } from './lib.mjs';

const FACH_PREFIXES = [
  'packages/tax/',
  'packages/db/prisma/migrations/',
  'apps/web/src/server/fristen/',
  'apps/web/src/server/invoicing/',
  'apps/web/src/app/staff/(protected)/clients/[id]/notices/',
  'apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/',
  'apps/web/src/app/staff/(protected)/tax-deadlines/',
  'apps/web/src/app/staff/(protected)/invoices/',
  'apps/web/src/app/portal/(protected)/invoices/',
  'apps/web/src/app/api/staff/invoices/',
  'apps/worker/src/jobs/tax-deadline-',
  'apps/worker/src/jobs/invoice-',
  'apps/worker/src/jobs/reminders-daily.ts',
];
const FACH_FILES = new Set(['packages/db/prisma/schema.prisma']);
const CATALOG_RULE_PREFIX = 'docs/fachkatalog/regeln/';
const EXCEPTION_LOG = 'docs/fachkatalog/AENDERUNGEN.md';
const EXCEPTION_ID_PATTERN = /^FK-EXC-\d{8}-\d{3}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d{3}$/;
const TEST_PATH_PATTERN =
  /^(?:apps|packages)\/.+(?:\/__tests__\/[^/]+|\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/;

export function isFachPath(file) {
  return FACH_FILES.has(file) || FACH_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function changePaths(change) {
  return [change.oldPath, change.path].filter((file) => typeof file === 'string');
}

export function evaluateCatalogDiff(
  changes,
  {
    baseRuleIds = [],
    headRuleIds = [],
    documentedFachPaths = [],
    newExceptionPaths = [],
    extraFindings = [],
  } = {},
) {
  const deletedRules = changes
    .filter(
      (change) =>
        (change.status.startsWith('D') && change.path.startsWith(CATALOG_RULE_PREFIX)) ||
        (change.status.startsWith('R') &&
          change.oldPath?.startsWith(CATALOG_RULE_PREFIX) &&
          !change.path.startsWith(CATALOG_RULE_PREFIX)),
    )
    .map((change) => change.oldPath ?? change.path);
  const fachChanges = [...new Set(changes.flatMap(changePaths).filter((file) => isFachPath(file)))];
  const removedRuleIds = baseRuleIds.filter((id) => !headRuleIds.includes(id));
  const documented = new Set([...documentedFachPaths, ...newExceptionPaths]);
  const undocumentedFachChanges = fachChanges.filter((file) => !documented.has(file));
  const findings = [...extraFindings];

  if (deletedRules.length > 0) {
    findings.push(
      `Fachregeln dürfen nicht gelöscht werden; als superseded erhalten: ${deletedRules.join(', ')}`,
    );
  }
  if (removedRuleIds.length > 0) {
    findings.push(
      `Historische Regel-IDs müssen erhalten bleiben und bei Ablösung superseded werden: ${removedRuleIds.join(', ')}`,
    );
  }
  if (undocumentedFachChanges.length > 0) {
    findings.push(
      `Fachpfade geändert, aber keiner geänderten Regel oder neuen strukturierten Ausnahme zugeordnet: ${undocumentedFachChanges.join(', ')}`,
    );
  }
  return {
    findings,
    fachChanges,
    undocumentedFachChanges,
    removedRuleIds,
  };
}

export function parseNameStatus(output) {
  if (output.length === 0) return [];
  if (!output.includes('\0')) {
    throw new Error('git-diff-Ausgabe muss NUL-getrennt sein.');
  }
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!status || !firstPath) throw new Error('Unerwartete NUL-getrennte git-diff-Ausgabe.');
    if (status.startsWith('R')) {
      const secondPath = fields[index++];
      if (!secondPath) throw new Error('Unerwartete NUL-getrennte git-rename-Ausgabe.');
      changes.push({ status, oldPath: firstPath, path: secondPath });
    } else {
      changes.push({ status, path: firstPath });
    }
  }
  return changes;
}

function git(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', options.ignoreErrors ? 'ignore' : 'pipe'],
  });
  return options.raw ? output : output.trim();
}

function commitExists(candidate) {
  if (!candidate || !/^[0-9a-f]{7,64}$/i.test(candidate) || /^0+$/.test(candidate)) return false;
  try {
    git(['cat-file', '-e', `${candidate}^{commit}`], { ignoreErrors: true });
    return true;
  } catch {
    return false;
  }
}

function hasCommit(candidate) {
  try {
    git(['rev-parse', '--verify', candidate], { ignoreErrors: true });
    return true;
  } catch {
    return false;
  }
}

function emptyTree() {
  return git(['mktree'], { input: '' });
}

function worktreeChanges() {
  const tracked = parseNameStatus(
    git(['diff', '--name-status', '-z', '--find-renames', 'HEAD'], { raw: true }),
  );
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], { raw: true })
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ status: 'A', path }));
  return [...tracked, ...untracked];
}

function resolveDiffContext() {
  const prBase = (process.env['FACHKATALOG_PR_BASE'] ?? '').trim();
  const pushBase = (process.env['FACHKATALOG_PUSH_BASE'] ?? '').trim();
  const requestedBase = prBase || pushBase;
  if (requestedBase) {
    if (/^0+$/.test(requestedBase)) {
      const defaultBranch = (process.env['FACHKATALOG_DEFAULT_BRANCH'] ?? '').trim();
      const defaultRef = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : '';
      if (defaultRef && hasCommit(defaultRef)) {
        const mergeBase = git(['merge-base', defaultRef, 'HEAD']);
        return {
          base: mergeBase,
          target: 'HEAD',
          changes: parseNameStatus(
            git(['diff', '--name-status', '-z', '--find-renames', `${mergeBase}...HEAD`], {
              raw: true,
            }),
          ),
        };
      }
      return {
        base: null,
        target: 'HEAD',
        changes: parseNameStatus(
          git(['diff', '--name-status', '-z', '--find-renames', emptyTree(), 'HEAD'], {
            raw: true,
          }),
        ),
      };
    }
    if (!commitExists(requestedBase)) {
      throw new Error(
        `Angeforderter CI-Basis-Commit ${requestedBase} ist nicht verfügbar; Diff-Gate bricht sicher ab.`,
      );
    }
    return {
      base: requestedBase,
      target: 'HEAD',
      changes: parseNameStatus(
        git(
          [
            'diff',
            '--name-status',
            '-z',
            '--find-renames',
            prBase ? `${requestedBase}...HEAD` : `${requestedBase}..HEAD`,
          ],
          { raw: true },
        ),
      ),
    };
  }

  const localChanges = worktreeChanges();
  if (localChanges.length > 0) {
    return { base: 'HEAD', target: 'WORKTREE', changes: localChanges };
  }
  if (hasCommit('HEAD^')) {
    return {
      base: 'HEAD^',
      target: 'HEAD',
      changes: parseNameStatus(
        git(['diff', '--name-status', '-z', '--find-renames', 'HEAD^', 'HEAD'], {
          raw: true,
        }),
      ),
    };
  }
  return {
    base: null,
    target: 'HEAD',
    changes: parseNameStatus(
      git(['diff', '--name-status', '-z', '--find-renames', emptyTree(), 'HEAD'], { raw: true }),
    ),
  };
}

function catalogRecordsAtCommit(commit) {
  if (!commit) return [];
  const paths = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', CATALOG_RULE_PREFIX], {
    raw: true,
  })
    .split('\0')
    .filter((path) => path.endsWith('.md'));
  return paths.map((path) => {
    const { metadata } = parseRuleSource(git(['show', `${commit}:${path}`]), `${commit}:${path}`);
    if (typeof metadata.id !== 'string') {
      throw new Error(`${commit}:${path}: Regel-ID fehlt.`);
    }
    return { ...metadata, path };
  });
}

function catalogRecordsAtTarget(target) {
  return target === 'WORKTREE' ? loadCatalog(process.cwd()) : catalogRecordsAtCommit(target);
}

function changedRuleEvidence(changes, baseRules, headRules) {
  const changedRulePaths = new Set(
    changes.flatMap(changePaths).filter((path) => path.startsWith(CATALOG_RULE_PREFIX)),
  );
  const changedRules = [...baseRules, ...headRules].filter((rule) =>
    changedRulePaths.has(rule.path),
  );
  return [
    ...new Set(
      changedRules.flatMap((rule) => [
        ...(Array.isArray(rule.code_refs) ? rule.code_refs : []),
        ...(Array.isArray(rule.test_refs) ? rule.test_refs : []),
      ]),
    ),
  ];
}

function fileAtCommit(commit, path) {
  if (!commit) return null;
  try {
    return git(['show', `${commit}:${path}`], { ignoreErrors: true });
  } catch {
    return null;
  }
}

function fileAtTarget(target, path) {
  if (target === 'WORKTREE') return existsSync(path) ? readFileSync(path, 'utf8') : null;
  return fileAtCommit(target, path);
}

export function parseExceptionLedger(source, label = EXCEPTION_LOG) {
  if (source === null) return [];
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${label}: strukturierte YAML-Kopfdaten fehlen.`);
  const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA, json: false });
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !Array.isArray(metadata.exceptions) ||
    Object.keys(metadata).some((key) => key !== 'exceptions')
  ) {
    throw new Error(`${label}: Kopfdaten müssen ausschließlich exceptions als Liste enthalten.`);
  }
  const ids = new Set();
  return metadata.exceptions.map((entry, index) => {
    const entryLabel = `${label}: exceptions[${index}]`;
    const keys = ['id', 'date', 'paths', 'rule_ids', 'reason', 'tests', 'reviewer'];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${entryLabel} muss ein Objekt sein.`);
    }
    const unknown = Object.keys(entry).filter((key) => !keys.includes(key));
    const missing = keys.filter((key) => !(key in entry));
    if (unknown.length || missing.length) {
      throw new Error(
        `${entryLabel} hat ungültige Felder (fehlend: ${missing.join(', ') || 'keine'}; unbekannt: ${unknown.join(', ') || 'keine'}).`,
      );
    }
    if (typeof entry.id !== 'string' || !EXCEPTION_ID_PATTERN.test(entry.id)) {
      throw new Error(`${entryLabel}.id muss FK-EXC-YYYYMMDD-001 entsprechen.`);
    }
    if (ids.has(entry.id)) throw new Error(`${entryLabel}.id ist doppelt: ${entry.id}.`);
    ids.add(entry.id);
    const parsedDate = new Date(`${entry.date}T00:00:00.000Z`);
    if (
      typeof entry.date !== 'string' ||
      !ISO_DATE_PATTERN.test(entry.date) ||
      Number.isNaN(parsedDate.valueOf()) ||
      parsedDate.toISOString().slice(0, 10) !== entry.date ||
      entry.date > new Date().toISOString().slice(0, 10)
    ) {
      throw new Error(`${entryLabel}.date muss ein heutiges oder früheres ISO-Datum sein.`);
    }
    for (const key of ['paths', 'rule_ids', 'tests']) {
      if (
        !Array.isArray(entry[key]) ||
        entry[key].length === 0 ||
        entry[key].some((value) => typeof value !== 'string' || value.length === 0)
      ) {
        throw new Error(`${entryLabel}.${key} muss eine nicht leere String-Liste sein.`);
      }
    }
    if (entry.paths.some((path) => !isFachPath(path))) {
      throw new Error(`${entryLabel}.paths darf nur überwachte Fachpfade enthalten.`);
    }
    if (entry.rule_ids.some((id) => !RULE_ID_PATTERN.test(id))) {
      throw new Error(`${entryLabel}.rule_ids enthält keine gültige Regel-ID.`);
    }
    if (
      entry.tests.some((path) => !TEST_PATH_PATTERN.test(path) || /\.d\.[cm]?[jt]sx?$/.test(path))
    ) {
      throw new Error(`${entryLabel}.tests darf nur ausführbare Repository-Testdateien nennen.`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 30) {
      throw new Error(`${entryLabel}.reason muss die Verhaltensneutralität konkret begründen.`);
    }
    if (typeof entry.reviewer !== 'string' || entry.reviewer.trim().length < 3) {
      throw new Error(`${entryLabel}.reviewer muss die prüfende Person nennen.`);
    }
    return entry;
  });
}

function newExceptions(baseSource, headSource, headRuleIds) {
  if (headSource === null) {
    return {
      findings: [`${EXCEPTION_LOG} fehlt im Zielstand.`],
      paths: [],
    };
  }
  const baseEntries = parseExceptionLedger(baseSource, `${EXCEPTION_LOG}@base`);
  const headEntries = parseExceptionLedger(headSource, `${EXCEPTION_LOG}@head`);
  const headById = new Map(headEntries.map((entry) => [entry.id, entry]));
  const findings = [];
  for (const baseEntry of baseEntries) {
    const headEntry = headById.get(baseEntry.id);
    if (!headEntry || JSON.stringify(headEntry) !== JSON.stringify(baseEntry)) {
      findings.push(
        `Bestehende Fachkatalog-Ausnahme darf nicht gelöscht oder verändert werden: ${baseEntry.id}`,
      );
    }
  }
  const baseIds = new Set(baseEntries.map((entry) => entry.id));
  const added = headEntries.filter((entry) => !baseIds.has(entry.id));
  for (const entry of added) {
    const unknownRuleIds = entry.rule_ids.filter((id) => !headRuleIds.includes(id));
    if (unknownRuleIds.length > 0) {
      findings.push(`${entry.id} verweist auf unbekannte Regel-IDs: ${unknownRuleIds.join(', ')}`);
    }
    const referenceErrors = [];
    entry.tests.forEach((path, index) =>
      assertRepositoryFile(
        process.cwd(),
        path,
        `${entry.id}.tests[${index}]`,
        referenceErrors,
        EXCEPTION_LOG,
      ),
    );
    findings.push(...referenceErrors);
  }
  return {
    findings,
    paths: added.flatMap((entry) => entry.paths),
  };
}

export function runDiffGuard() {
  const context = resolveDiffContext();
  const baseRules = catalogRecordsAtCommit(context.base);
  const headRules = catalogRecordsAtTarget(context.target);
  const baseRuleIds = baseRules.map((rule) => rule.id);
  const headRuleIds = headRules.map((rule) => rule.id);
  const exceptions = newExceptions(
    fileAtCommit(context.base, EXCEPTION_LOG),
    fileAtTarget(context.target, EXCEPTION_LOG),
    headRuleIds,
  );
  const result = evaluateCatalogDiff(context.changes, {
    baseRuleIds,
    headRuleIds,
    documentedFachPaths: changedRuleEvidence(context.changes, baseRules, headRules),
    newExceptionPaths: exceptions.paths,
    extraFindings: exceptions.findings,
  });
  if (result.findings.length > 0) {
    throw new Error(`Fachkatalog-Diff-Gate fehlgeschlagen:\n- ${result.findings.join('\n- ')}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runDiffGuard();
    console.log(
      result.fachChanges.length > 0
        ? `Fachkatalog-Diff-Gate erfüllt: ${result.fachChanges.length} Fachpfad-Änderungen konkret zugeordnet.`
        : 'Fachkatalog-Diff-Gate erfüllt: keine Fachpfad-Änderungen.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
