// Review-Finding F-09: eine Quelle je Upload-Art für Serverprüfung, UI-Anzeige
// und das Server-Action-Body-Limit.
import { describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import nextConfig from '../../../next.config.mjs';
import {
  MAX_UPLOAD_BYTES_BY_KIND,
  SERVER_ACTION_BODY_LIMIT_BYTES,
  STORAGE_MAX_UPLOAD_BYTES,
  UPLOAD_ACTION_OVERHEAD_BYTES,
  formatUploadLimit,
} from '../upload-limits.mjs';

// Loading build configuration must not read developer secrets or change test ENVs.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const MIB = 1024 * 1024;

/**
 * Multipart-Body, wie React ihn für `action(input, upload)` sendet: die
 * JSON-Argumente als Textfeld und die Datei als binärer Teil.
 */
async function encodedActionBodyBytes(fileBytes: number): Promise<number> {
  const body = new FormData();
  body.set(
    '0',
    JSON.stringify([
      {
        clientId: '11111111-1111-4111-8111-111111111111',
        submissionId: '22222222-2222-4222-8222-222222222222',
        fieldKey: 'beleg',
        token: 'x'.repeat(64),
        personName: 'Ä'.repeat(200),
      },
      '$K1',
    ]),
  );
  body.set(
    '1_file',
    new File([new Uint8Array(fileBytes)], `${'n'.repeat(200)}.pdf`, { type: 'application/pdf' }),
  );
  const request = new Request('http://localhost/action', { method: 'POST', body });
  return (await request.arrayBuffer()).byteLength;
}

describe('Upload-Grenzen je Upload-Art', () => {
  it('spiegelt die globale Storage-Obergrenze und überschreitet sie mit keiner Art', () => {
    expect(STORAGE_MAX_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES);
    for (const [kind, limit] of Object.entries(MAX_UPLOAD_BYTES_BY_KIND)) {
      expect(limit, kind).toBeGreaterThan(0);
      expect(limit, kind).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    }
  });

  it('behält die fachlich gesetzten Grenzen der bisherigen base64-Pfade bei', () => {
    expect(MAX_UPLOAD_BYTES_BY_KIND).toMatchObject({
      externalInvoicePdf: 10 * MIB,
      taxFilingPdf: 10 * MIB,
      bwaXlsx: 20 * MIB,
      portalFormFile: 10 * MIB,
      gwgOnboardingFile: 10 * MIB,
    });
  });

  it('leitet das Server-Action-Body-Limit aus der größten Upload-Art ab', () => {
    expect(SERVER_ACTION_BODY_LIMIT_BYTES).toBe(
      Math.max(...Object.values(MAX_UPLOAD_BYTES_BY_KIND)) + UPLOAD_ACTION_OVERHEAD_BYTES,
    );
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(
      SERVER_ACTION_BODY_LIMIT_BYTES,
    );
  });

  it('lässt jede Datei genau an ihrer Grenze samt Multipart-Rahmen durch das Body-Limit', async () => {
    for (const [kind, limit] of Object.entries(MAX_UPLOAD_BYTES_BY_KIND)) {
      const bytes = await encodedActionBodyBytes(limit);
      expect(bytes, kind).toBeGreaterThan(limit);
      expect(bytes, kind).toBeLessThanOrEqual(SERVER_ACTION_BODY_LIMIT_BYTES);
    }
  });

  it('hätte die 20-MB-XLSX als base64-String nie durch ein 10-MB-Limit gebracht', () => {
    // Regression F-09: 4 Zeichen je 3 Bytes. Schon 7,5 MB übersteigen 10 MB.
    expect(Math.ceil((7.6 * MIB) / 3) * 4).toBeGreaterThan(10 * MIB);
    expect(Math.ceil(MAX_UPLOAD_BYTES_BY_KIND.bwaXlsx / 3) * 4).toBeGreaterThan(
      SERVER_ACTION_BODY_LIMIT_BYTES,
    );
  });

  it('zeigt Grenzen in MB an', () => {
    expect(formatUploadLimit(10 * MIB)).toBe('10 MB');
    expect(formatUploadLimit(20 * MIB)).toBe('20 MB');
    expect(formatUploadLimit(7.5 * MIB)).toBe('7,5 MB');
  });
});
