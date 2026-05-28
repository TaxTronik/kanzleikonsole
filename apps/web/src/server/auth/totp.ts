import {
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';

// IV (12 Byte) || AuthTag (16 Byte) || Ciphertext
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(tenantId: string, authSecret: string): Buffer {
  const result = hkdfSync(
    'sha256',
    Buffer.from(authSecret, 'utf8'),
    Buffer.from(tenantId, 'utf8'),
    Buffer.from('taxtronik-totp-key', 'utf8'),
    32,
  );
  return Buffer.from(result);
}

export function encryptTotpSecret(
  secret: string,
  tenantId: string,
  authSecret: string,
): string {
  const key = deriveKey(tenantId, authSecret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptTotpSecret(
  encoded: string,
  tenantId: string,
  authSecret: string,
): string {
  const key = deriveKey(tenantId, authSecret);
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function buildTotpUri(
  email: string,
  secret: string,
  issuer = 'taxtronik',
): string {
  return generateURI({ issuer, label: email, secret });
}

export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return verifySync({ token: code, secret }).valid;
  } catch {
    return false;
  }
}
