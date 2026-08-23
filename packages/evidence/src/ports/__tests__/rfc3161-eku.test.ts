import { describe, expect, it } from 'vitest';
import type { Certificate } from 'pkijs';
import { hasTimestampingEku } from '../rfc3161-verify';

const EXT_EKU_OID = '2.5.29.37';
const EKU_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const EKU_CODESIGNING = '1.3.6.1.5.5.7.3.3';

function certWithEku(keyPurposes: string[], critical = true): Certificate {
  return {
    extensions: [
      {
        extnID: EXT_EKU_OID,
        critical,
        parsedValue: { keyPurposes },
      },
    ],
  } as unknown as Certificate;
}

describe('RFC-3161 TSA Extended Key Usage', () => {
  it('akzeptiert genau den kritischen, ausschliesslichen timeStamping-Zweck', () => {
    expect(hasTimestampingEku(certWithEku([EKU_TIMESTAMPING]))).toBe(true);
  });

  it('lehnt timeStamping in einem kritischen Mehrzweckzertifikat ab', () => {
    expect(hasTimestampingEku(certWithEku([EKU_TIMESTAMPING, EKU_CODESIGNING]))).toBe(false);
  });

  it('lehnt nicht-kritische und fremde EKUs ab', () => {
    expect(hasTimestampingEku(certWithEku([EKU_TIMESTAMPING], false))).toBe(false);
    expect(hasTimestampingEku(certWithEku([EKU_CODESIGNING]))).toBe(false);
  });
});
