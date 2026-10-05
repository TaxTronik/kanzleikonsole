// =============================================================================
// P-06: Modul- und Settings-Prüfungen INNERHALB einer laufenden Transaktion
// müssen deren Verbindung nutzen. `readModules(ctx)` & Co. öffnen eine eigene
// Transaktion; im Callback einer laufenden Transaktion belegt das eine zweite
// Pool-Verbindung und kann den Pool unter Last verklemmen.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  readTenantSettingValue: vi.fn(),
}));

vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/db/tenant-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/db/tenant-settings')>()),
  readTenantSettingValue: m.readTenantSettingValue,
}));

import {
  assertModuleEnabledTx,
  DEFAULT_MODULES,
  ModuleDisabledError,
  readModulesTx,
} from '../modules';
import type { TxClient } from '@taxtronik/db';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Reader, die selbst `withTenantContext` öffnen und eine Tx-Variante haben. */
const OWN_TRANSACTION_READERS = new Set([
  'readModules',
  'assertModuleEnabled',
  'readPortalFeatures',
  'assertPortalFeature',
  'readBranding',
  'readAccessibleDisplay',
  'readAccessibleDisplayOptions',
  'readSellerInfo',
  'readTaxRegion',
  'readTaxRegionSetting',
  'readLegal',
  'readPrivacyConfig',
  'getSmtpStatus',
]);

function walkProductionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') files.push(...walkProductionSources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function opensTransaction(fn: ts.SignatureDeclaration, source: ts.SourceFile): boolean {
  return fn.parameters.some((param) => {
    const type = param.type?.getText(source) ?? '';
    return (
      /\b(?:TxClient|TransactionClient)\b/.test(type) ||
      (ts.isIdentifier(param.name) && param.name.text === 'tx')
    );
  });
}

function nestedReaderCalls(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (![...OWN_TRANSACTION_READERS].some((name) => text.includes(`${name}(`))) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const visit = (node: ts.Node, insideTx: boolean): void => {
    if (ts.isCallExpression(node) && insideTx) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (OWN_TRANSACTION_READERS.has(name)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push(`${relative(SRC_DIR, file)}:${line + 1} ${name}`);
      }
    }
    const entersTx =
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      opensTransaction(node, source);
    ts.forEachChild(node, (child) => visit(child, insideTx || entersTx));
  };
  visit(source, false);
  return findings;
}

describe('Modul-Checks in laufenden Transaktionen (P-06)', () => {
  it('nutzen die Tx-Variante statt einer zweiten Transaktion', () => {
    const findings = walkProductionSources(SRC_DIR).flatMap(nestedReaderCalls);
    expect(findings).toEqual([]);
  });
});

describe('assertModuleEnabledTx / readModulesTx', () => {
  const tx = {} as TxClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('liest über die übergebene Transaktion und öffnet keine eigene', async () => {
    m.readTenantSettingValue.mockResolvedValue({ forms: true });

    await expect(assertModuleEnabledTx(tx, 'tenant-a', 'forms')).resolves.toBeUndefined();
    expect(m.readTenantSettingValue).toHaveBeenCalledWith(tx, 'tenant-a', 'modules');
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('wirft bei deaktiviertem Modul wie assertModuleEnabled', async () => {
    m.readTenantSettingValue.mockResolvedValue({ forms: false });

    await expect(assertModuleEnabledTx(tx, 'tenant-a', 'forms')).rejects.toBeInstanceOf(
      ModuleDisabledError,
    );
  });

  it('nutzt ohne gespeicherte Konfiguration die Defaults', async () => {
    m.readTenantSettingValue.mockResolvedValue(undefined);

    await expect(readModulesTx(tx, 'tenant-a')).resolves.toEqual(DEFAULT_MODULES);
    await expect(assertModuleEnabledTx(tx, 'tenant-a', 'risk')).rejects.toBeInstanceOf(
      ModuleDisabledError,
    );
  });
});
