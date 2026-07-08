// =============================================================================
// Unit-Tests: resolveTsaTrustedRoots (Operator-Root-Merge via ENV-Datei).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTsaTrustedRoots, __resetTsaRootsCache } from '../resolve-roots';
import { DEFAULT_TSA_TRUSTED_ROOTS } from '../globalsign-roots';

const EXTRA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBExtraRootCertificateBase64Payload==',
  '-----END CERTIFICATE-----',
].join('\n');

let dir: string;

beforeEach(() => {
  __resetTsaRootsCache();
  delete process.env['TSA_TRUSTED_ROOTS_FILE'];
  dir = mkdtempSync(join(tmpdir(), 'tsa-roots-'));
});

afterEach(() => {
  __resetTsaRootsCache();
  delete process.env['TSA_TRUSTED_ROOTS_FILE'];
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveTsaTrustedRoots', () => {
  it('ohne ENV: nur der eingebaute Default (GlobalSign R6)', () => {
    expect(resolveTsaTrustedRoots()).toEqual(DEFAULT_TSA_TRUSTED_ROOTS);
  });

  it('mit ENV-Datei: Default + zusätzliche Roots (gemergt)', () => {
    const file = join(dir, 'roots.pem');
    writeFileSync(file, EXTRA_PEM);
    process.env['TSA_TRUSTED_ROOTS_FILE'] = file;
    const roots = resolveTsaTrustedRoots();
    expect(roots.length).toBe(DEFAULT_TSA_TRUSTED_ROOTS.length + 1);
    expect(roots).toEqual(expect.arrayContaining([...DEFAULT_TSA_TRUSTED_ROOTS, EXTRA_PEM]));
  });

  it('dedupliziert einen Root, der schon im Default steht', () => {
    const file = join(dir, 'roots.pem');
    // Default-Root erneut in die Datei schreiben → darf nicht doppelt erscheinen.
    writeFileSync(file, DEFAULT_TSA_TRUSTED_ROOTS[0]!);
    process.env['TSA_TRUSTED_ROOTS_FILE'] = file;
    expect(resolveTsaTrustedRoots().length).toBe(DEFAULT_TSA_TRUSTED_ROOTS.length);
  });

  it('unlesbare Datei: Fallback auf Default, kein Wurf', () => {
    process.env['TSA_TRUSTED_ROOTS_FILE'] = join(dir, 'does-not-exist.pem');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveTsaTrustedRoots()).toEqual(DEFAULT_TSA_TRUSTED_ROOTS);
    expect(warn).toHaveBeenCalled();
  });

  it('Datei ohne PEM-Block: Fallback auf Default', () => {
    const file = join(dir, 'junk.pem');
    writeFileSync(file, 'kein zertifikat hier');
    process.env['TSA_TRUSTED_ROOTS_FILE'] = file;
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveTsaTrustedRoots()).toEqual(DEFAULT_TSA_TRUSTED_ROOTS);
    expect(warn).toHaveBeenCalled();
  });
});
