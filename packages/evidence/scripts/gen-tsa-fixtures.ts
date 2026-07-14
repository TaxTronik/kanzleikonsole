// =============================================================================
// Generator für SYNTHETISCHE RFC-3161-Negativ-Fixtures (Mini-CA).
//
// Erzeugt deterministische TimeStampResp-Tokens mit voller Kontrolle über
// genTime + Cert-Gültigkeit + EKU-Kritikalität — das, was `openssl ts` NICHT
// kann (genTime = immer „jetzt"). Damit lassen sich die Abnahme-Negativfälle
// 3 (fremde/selbstsignierte Kette), 4 (nicht-kritische EKU) und 5 (Zeitlogik:
// genTime in Gültigkeit, Cert heute abgelaufen → muss PASSEN) bauen.
//
// Ausführen:  pnpm --filter @taxtronik/evidence tsx scripts/gen-tsa-fixtures.ts
// Schreibt nach src/__tests__/fixtures/ und prüft jede Erwartung sofort gegen
// die echte verifyTimestampResponse() (fängt Generator-Bugs).
// =============================================================================

import { webcrypto, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as asn1js from 'asn1js';
import {
  Certificate,
  AttributeTypeAndValue,
  Extension,
  BasicConstraints,
  ExtKeyUsage,
  AlgorithmIdentifier,
  TSTInfo,
  MessageImprint,
  SignedData,
  SignerInfo,
  IssuerAndSerialNumber,
  EncapsulatedContentInfo,
  ContentInfo,
  TimeStampResp,
  PKIStatusInfo,
  Attribute,
  SignedAndUnsignedAttributes,
  CryptoEngine,
  setEngine,
} from 'pkijs';
import { verifyTimestampResponse } from '../src/ports/rfc3161-verify';

const crypto = webcrypto as unknown as Crypto;
setEngine(
  'gen',
  new CryptoEngine({ name: 'gen', crypto }) as unknown as Parameters<typeof setEngine>[1],
);

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, '..', 'src', '__tests__', 'fixtures');

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const EKU_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const EKU_CODESIGNING = '1.3.6.1.5.5.7.3.3';

function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

async function genRsa(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

interface CertOpts {
  subjectCN: string;
  issuerCN: string;
  subjectPublicKey: CryptoKey;
  issuerPrivateKey: CryptoKey;
  isCa: boolean;
  eku?: string[];
  ekuCritical?: boolean;
  notBefore: Date;
  notAfter: Date;
  serial: number;
}

async function makeCert(o: CertOpts): Promise<Certificate> {
  const cert = new Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: o.serial });
  cert.issuer.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: o.issuerCN }),
    }),
  );
  cert.subject.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: o.subjectCN }),
    }),
  );
  cert.notBefore.value = o.notBefore;
  cert.notAfter.value = o.notAfter;
  await cert.subjectPublicKeyInfo.importKey(o.subjectPublicKey);
  cert.extensions = [];
  const bc = new BasicConstraints({ cA: o.isCa });
  cert.extensions.push(
    new Extension({
      extnID: '2.5.29.19',
      critical: true,
      extnValue: bc.toSchema().toBER(false),
      parsedValue: bc,
    }),
  );
  if (o.eku) {
    const eku = new ExtKeyUsage({ keyPurposes: o.eku });
    cert.extensions.push(
      new Extension({
        extnID: '2.5.29.37',
        critical: !!o.ekuCritical,
        extnValue: eku.toSchema().toBER(false),
        parsedValue: eku,
      }),
    );
  }
  await cert.sign(o.issuerPrivateKey, 'SHA-256');
  return cert;
}

async function makeToken(
  leafCert: Certificate,
  leafKey: CryptoKey,
  payload: Uint8Array,
  genTime: Date,
  serial: number,
  withEss = true,
): Promise<Uint8Array> {
  const imprint = new Uint8Array(createHash('sha256').update(payload).digest());
  const tstInfo = new TSTInfo({
    version: 1,
    policy: '1.2.3.4.1',
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({
        algorithmId: SHA256_OID,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
    }),
    serialNumber: new asn1js.Integer({ value: serial }),
    genTime,
  });
  const tstDer = tstInfo.toSchema().toBER(false);

  // Signierte Attribute wie ein echtes TSA-Token: content-type, signing-time,
  // message-digest (über den eContent-Wert) UND die ESS-Bindung signingCertificateV2.
  const messageDigest = await crypto.subtle.digest('SHA-256', tstDer);
  const certDer = leafCert.toSchema().toBER(false);
  const certHash = createHash('sha256').update(Buffer.from(certDer)).digest();
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: ab(new Uint8Array(certHash)) })],
  });
  const signingCertV2 = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [essCertIdV2] })],
  });

  const signedAttrs = withEss
    ? new SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new Attribute({
            type: '1.2.840.113549.1.9.3',
            values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.9.16.1.4' })],
          }),
          new Attribute({
            type: '1.2.840.113549.1.9.5',
            values: [new asn1js.UTCTime({ valueDate: genTime })],
          }),
          new Attribute({
            type: '1.2.840.113549.1.9.4',
            values: [new asn1js.OctetString({ valueHex: messageDigest })],
          }),
          new Attribute({ type: '1.2.840.113549.1.9.16.2.47', values: [signingCertV2] }),
        ],
      })
    : undefined;

  const signerInfo = signedAttrs
    ? new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: leafCert.issuer,
          serialNumber: leafCert.serialNumber,
        }),
        signedAttrs,
      })
    : new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: leafCert.issuer,
          serialNumber: leafCert.serialNumber,
        }),
      });

  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.9.16.1.4', // id-ct-TSTInfo
      eContent: new asn1js.OctetString({ valueHex: tstDer }),
    }),
    signerInfos: [signerInfo],
    certificates: [leafCert],
  });
  await signedData.sign(leafKey, 0, 'SHA-256');
  // pkijs' EncapsulatedContentInfo chunkt eContent IMMER zu einer konstruierten
  // OCTET STRING (kein disableSplit) — und scheitert dann an seinem eigenen
  // verify(). Echte TSAs liefern primitiv. Nach dem Signieren (Signatur ist über
  // den eContent-WERT, nicht die Hülle) auf primitiv zurücksetzen.
  (signedData.encapContentInfo as unknown as { eContent: asn1js.OctetString }).eContent =
    new asn1js.OctetString({ valueHex: tstDer });

  const cms = new ContentInfo({
    contentType: '1.2.840.113549.1.7.2',
    content: signedData.toSchema(true),
  });
  const resp = new TimeStampResp({ status: new PKIStatusInfo({ status: 0 }), timeStampToken: cms });
  return new Uint8Array(resp.toSchema().toBER(false));
}

function toPem(cert: Certificate): string {
  const der = Buffer.from(cert.toSchema(true).toBER(false));
  const b64 = (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

async function main() {
  const payload = new TextEncoder().encode('taxtronik-synthetic-fixture-payload');

  const rootKp = await genRsa();
  const wide = {
    notBefore: new Date('2015-01-01T00:00:00Z'),
    notAfter: new Date('2035-01-01T00:00:00Z'),
  };
  const rootCert = await makeCert({
    subjectCN: 'taxtronik Test Root CA',
    issuerCN: 'taxtronik Test Root CA',
    subjectPublicKey: rootKp.publicKey,
    issuerPrivateKey: rootKp.privateKey,
    isCa: true,
    serial: 1,
    ...wide,
  });
  const rootPem = toPem(rootCert);

  // Leaf A — gültige TSA: EKU timeStamping KRITISCH, breite Gültigkeit.
  const goodKp = await genRsa();
  const goodLeaf = await makeCert({
    subjectCN: 'taxtronik Test TSA (good)',
    issuerCN: 'taxtronik Test Root CA',
    subjectPublicKey: goodKp.publicKey,
    issuerPrivateKey: rootKp.privateKey,
    isCa: false,
    eku: [EKU_TIMESTAMPING],
    ekuCritical: true,
    serial: 2,
    ...wide,
  });
  const goodTsr = await makeToken(goodLeaf, goodKp.privateKey, payload, new Date(), 1001);

  // Leaf B — EKU timeStamping NICHT kritisch → muss abgelehnt werden (RFC 3161 §2.3).
  const ncKp = await genRsa();
  const ncLeaf = await makeCert({
    subjectCN: 'taxtronik Test TSA (noncrit-eku)',
    issuerCN: 'taxtronik Test Root CA',
    subjectPublicKey: ncKp.publicKey,
    issuerPrivateKey: rootKp.privateKey,
    isCa: false,
    eku: [EKU_TIMESTAMPING],
    ekuCritical: false,
    serial: 3,
    ...wide,
  });
  const ncTsr = await makeToken(ncLeaf, ncKp.privateKey, payload, new Date(), 1002);

  // Leaf C — falscher EKU-Zweck (codeSigning, kritisch) → kein TSA-Cert → ablehnen.
  const wrongKp = await genRsa();
  const wrongLeaf = await makeCert({
    subjectCN: 'taxtronik Test TSA (codesigning)',
    issuerCN: 'taxtronik Test Root CA',
    subjectPublicKey: wrongKp.publicKey,
    issuerPrivateKey: rootKp.privateKey,
    isCa: false,
    eku: [EKU_CODESIGNING],
    ekuCritical: true,
    serial: 4,
    ...wide,
  });
  const wrongTsr = await makeToken(wrongLeaf, wrongKp.privateKey, payload, new Date(), 1003);

  // Leaf D — Zeitlogik: Cert gültig NUR 2020, genTime 2020-06 (drin), Prüfung heute.
  // Muss PASSEN (Prüfung gegen genTime, nicht Date.now).
  const pastKp = await genRsa();
  const pastLeaf = await makeCert({
    subjectCN: 'taxtronik Test TSA (past-valid)',
    issuerCN: 'taxtronik Test Root CA',
    subjectPublicKey: pastKp.publicKey,
    issuerPrivateKey: rootKp.privateKey,
    isCa: false,
    eku: [EKU_TIMESTAMPING],
    ekuCritical: true,
    serial: 5,
    notBefore: new Date('2020-01-01T00:00:00Z'),
    notAfter: new Date('2020-12-31T23:59:59Z'),
  });
  const pastTsr = await makeToken(
    pastLeaf,
    pastKp.privateKey,
    payload,
    new Date('2020-06-01T12:00:00Z'),
    1004,
  );

  // Token OHNE ESS-Attribut (gültiges TSA-Cert, aber keine SigningCertificate-Bindung)
  // → muss abgelehnt werden (RFC 3161 §2.4.1; OpenSSL lehnt es ebenfalls ab).
  const noEssTsr = await makeToken(goodLeaf, goodKp.privateKey, payload, new Date(), 1005, false);

  // Schreiben.
  writeFileSync(join(fxDir, 'synthetic-payload.bin'), payload);
  writeFileSync(join(fxDir, 'synthetic-root.pem'), rootPem, 'utf8');
  writeFileSync(join(fxDir, 'synthetic-good.tsr'), goodTsr);
  writeFileSync(join(fxDir, 'synthetic-noncrit-eku.tsr'), ncTsr);
  writeFileSync(join(fxDir, 'synthetic-wrong-eku.tsr'), wrongTsr);
  writeFileSync(join(fxDir, 'synthetic-past-valid.tsr'), pastTsr);
  writeFileSync(join(fxDir, 'synthetic-no-ess.tsr'), noEssTsr);

  // Self-Check: jede Erwartung sofort gegen die echte verify() prüfen.
  const expect = async (
    name: string,
    tsr: Uint8Array,
    roots: string[],
    want: boolean,
    field?: 'chainTrusted',
  ) => {
    const r = await verifyTimestampResponse(payload, tsr, roots);
    const got = field ? r[field] : r.valid;
    const ok = got === want;
    console.log(
      `${ok ? 'OK ' : 'FAIL'}  ${name}: want ${field ?? 'valid'}=${want}, got=${got}${r.reason ? ` (${r.reason})` : ''}`,
    );
    if (!ok) process.exitCode = 1;
  };

  console.log('--- Self-Check ---');
  await expect('good vs eigener Root', goodTsr, [rootPem], true);
  await expect('good vs GlobalSign-Root (Fall 3: Pinning)', goodTsr, [GLOBALSIGN], false);
  await expect(
    'good vs GlobalSign-Root chainTrusted=false',
    goodTsr,
    [GLOBALSIGN],
    false,
    'chainTrusted',
  );
  await expect('noncrit-eku vs eigener Root (Fall 4)', ncTsr, [rootPem], false);
  await expect('wrong-eku vs eigener Root (Fall 4b)', wrongTsr, [rootPem], false);
  await expect('past-valid vs eigener Root HEUTE geprüft (Fall 5)', pastTsr, [rootPem], true);
  await expect('no-ess vs eigener Root (ESS-Pflicht)', noEssTsr, [rootPem], false);
  console.log('Fixtures geschrieben nach', fxDir);
}

// GlobalSign R6 nur für den Self-Check (Pinning-Gegenprobe) — inline, um nicht
// vom Test-Trust-Store abzuhängen.
import { GLOBALSIGN_ROOT_R6_PEM as GLOBALSIGN } from '../src/ports/globalsign-roots';

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
