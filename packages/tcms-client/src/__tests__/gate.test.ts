// TCMS Stufe 2: aktiv nur mit Modul `tcms` an UND TCMS_DEPLOYMENT != disabled.
import { generateKeyPairSync } from 'node:crypto';
import type { TcmsConfig } from '@taxtronik/config/env-schema';
import { describe, expect, it } from 'vitest';
import { istTcmsAktiv } from '../gate';

const config = {
  deployment: 'managed',
  url: 'http://tcms-api:3200',
  serviceToken: 'nicht-genutzt',
  actorKeyId: 'kk-1',
  actorPrivateKey: generateKeyPairSync('ed25519').privateKey,
} satisfies TcmsConfig;

describe('istTcmsAktiv', () => {
  it('verlangt Modulschalter und Konfiguration', () => {
    expect(istTcmsAktiv(true, config)).toBe(true);
    expect(istTcmsAktiv(false, config)).toBe(false);
    expect(istTcmsAktiv(true, null)).toBe(false);
    expect(istTcmsAktiv(false, null)).toBe(false);
  });
});
