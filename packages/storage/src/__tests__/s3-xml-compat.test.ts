// =============================================================================
// S3-Antworten durch den echten AWS-Client (Dependency-Audit 2026-11-17).
//
// @aws-sdk/xml-builder liest jede XML-Antwort des Object Stores mit
// fast-xml-parser. pnpm-workspace.yaml erzwingt dafür einen anderen Stand als den,
// den das SDK pinnt (Override fast-xml-parser). Dieser Test ersetzt nur die
// Netzwerkschicht und schickt typische Antworten von SeaweedFS/S3 durch den
// echten Client: Versionen mit Entitäten im Schlüssel, Object-Lock-Frist und
// -Konfiguration, Abschluss eines Multipart-Uploads und die Fehler, an denen die
// Löschsperre hängt. Ändert ein späteres Update die Auswertung, fällt es hier auf.
// =============================================================================

import { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';

/** S3-Client, dessen Netzwerkschicht eine feste Antwort liefert. */
function clientAnswering(statusCode: number, xml: string): S3Client {
  return new S3Client({
    region: 'eu-central-1',
    endpoint: 'http://seaweedfs:8333',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: {
      handle: async () => ({
        response: {
          statusCode,
          headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'R1' },
          body: Readable.from([Buffer.from(xml, 'utf8')]),
        },
      }),
    },
  });
}

describe('S3-Antworten mit dem erzwungenen fast-xml-parser', () => {
  it('liest Versionen samt Entitäten im Schlüssel, Zahlen, Wahrheitswerten und Löschmarken', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult ${NS}><Name>gobd</Name><Prefix>t/1/</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
<Version><Key>t/1/Rechnung &amp; Gutschrift – Müller &lt;Kopie&gt; &apos;a&apos; &quot;b&quot; &#169; &#x20AC;.pdf</Key><VersionId>3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-17T09:00:00.000Z</LastModified><ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag><Size>36351</Size></Version>
<DeleteMarker><Key>t/1/00123</Key><VersionId>null</VersionId><IsLatest>false</IsLatest><LastModified>2026-11-16T09:00:00.000Z</LastModified></DeleteMarker>
</ListVersionsResult>`;
    const out = await clientAnswering(200, xml).send(
      new ListObjectVersionsCommand({ Bucket: 'gobd', Prefix: 't/1/' }),
    );
    expect(out.IsTruncated).toBe(false);
    expect(out.Versions).toEqual([
      expect.objectContaining({
        Key: `t/1/Rechnung & Gutschrift – Müller <Kopie> 'a' "b" © €.pdf`,
        VersionId: '3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo',
        IsLatest: true,
        ETag: '"9b2cf535f27731c974343645a3985328"',
        Size: 36351,
        LastModified: new Date('2026-11-17T09:00:00.000Z'),
      }),
    ]);
    // Ein Schlüssel aus Ziffern bleibt Text, die Version "null" bleibt die Zeichenkette.
    expect(out.DeleteMarkers).toEqual([
      expect.objectContaining({ Key: 't/1/00123', VersionId: 'null', IsLatest: false }),
    ]);
  });

  it('lässt Leerraum und Zeilenumbruch in Schlüsseln unverändert', async () => {
    const xml = `<ListVersionsResult ${NS}><Name>gobd</Name><IsTruncated>true</IsTruncated><NextKeyMarker>a b </NextKeyMarker><Version><Key> führend.pdf</Key><VersionId>v1</VersionId><Size>0</Size></Version><Version><Key>mit
Umbruch.pdf</Key><VersionId>v2</VersionId><Size>12</Size></Version></ListVersionsResult>`;
    const out = await clientAnswering(200, xml).send(
      new ListObjectVersionsCommand({ Bucket: 'gobd' }),
    );
    expect(out.NextKeyMarker).toBe('a b ');
    expect(out.Versions?.map((version) => version.Key)).toEqual([
      ' führend.pdf',
      'mit\nUmbruch.pdf',
    ]);
  });

  it('liest Frist und Modus der Objektsperre', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Retention ${NS}><Mode>COMPLIANCE</Mode><RetainUntilDate>2037-01-01T00:00:00Z</RetainUntilDate></Retention>`;
    const out = await clientAnswering(200, xml).send(
      new GetObjectRetentionCommand({ Bucket: 'gobd', Key: 'a.pdf', VersionId: 'v1' }),
    );
    expect(out.Retention).toEqual({
      Mode: 'COMPLIANCE',
      RetainUntilDate: new Date('2037-01-01T00:00:00Z'),
    });
  });

  it('liest die Object-Lock-Konfiguration des Buckets', async () => {
    const xml = `<ObjectLockConfiguration ${NS}><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Years>10</Years></DefaultRetention></Rule></ObjectLockConfiguration>`;
    const out = await clientAnswering(200, xml).send(
      new GetObjectLockConfigurationCommand({ Bucket: 'gobd' }),
    );
    expect(out.ObjectLockConfiguration).toEqual({
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Years: 10 } },
    });
  });

  it('liest den Abschluss eines Multipart-Uploads mit Entitäten in Ort und ETag', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult ${NS}><Location>http://seaweedfs:8333/backup/db.dump?x=1&amp;y=2</Location><Bucket>backup</Bucket><Key>2026-11-17/db.dump</Key><ETag>&quot;3858f62230ac3c915f300c664312c11f-9&quot;</ETag></CompleteMultipartUploadResult>`;
    const out = await clientAnswering(200, xml).send(
      new CompleteMultipartUploadCommand({
        Bucket: 'backup',
        Key: '2026-11-17/db.dump',
        UploadId: 'U1',
        MultipartUpload: { Parts: [{ ETag: '"p1"', PartNumber: 1 }] },
      }),
    );
    expect(out).toMatchObject({
      Location: 'http://seaweedfs:8333/backup/db.dump?x=1&y=2',
      Bucket: 'backup',
      Key: '2026-11-17/db.dump',
      ETag: '"3858f62230ac3c915f300c664312c11f-9"',
    });
  });

  it('meldet die abgewiesene Löschung einer gesperrten Fassung mit Code und Text', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied because object protected by object lock &amp; retention</Message><Key>t/1/a&amp;b.pdf</Key><RequestId>17A8B</RequestId></Error>`;
    const error = await clientAnswering(403, xml)
      .send(new DeleteObjectCommand({ Bucket: 'gobd', Key: 't/1/a&b.pdf', VersionId: 'v1' }))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({
      name: 'AccessDenied',
      message: 'Access Denied because object protected by object lock & retention',
      $metadata: { httpStatusCode: 403 },
    });
  });
});
