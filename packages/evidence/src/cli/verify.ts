// =============================================================================
// CLI: pnpm verify:chain
//
// Rechnet die Hash-Chain für alle Tenants nach und gibt einen Bericht aus.
// Geeignet für Wirtschaftsprüfer/Revisoren, die unabhängig prüfen wollen.
//
// Erweitert: prüft zusätzlich die `audit_archive`-Einträge — lädt jede
// archivierte NDJSON-Datei aus dem Object-Store, prüft Datei-Hash gegen DB-Eintrag und
// rekonstruiert die Chain pro Segment. Bei einer DB-Lücke (HARD-Rotation)
// wird die Chain via Archiv-Datei rekonstruiert.
//
// Exit-Code 0 bei OK, 1 bei Bruch.
// =============================================================================

import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
// T-1: Bewusst Owner-Connection (BYPASSRLS) statt der App-Rolle. In Produktion
// liefert die App-Rolle ohne gesetzten `app.current_tenant_id` ein leeres
// `tenant.findMany()` zurück → CLI schlösse stillschweigend „grün" ab und
// würde Manipulationen nie entdecken. Compliance-blocker für die GoBD-
// Hash-Chain-Verifikation.
import { prismaOwner as prisma } from '@taxtronik/db';
import { EvidenceService } from '../service.js';
import { LocalTimestampAdapter } from '../ports/timestamp.js';
import { createRfc3161Adapter } from '../ports/rfc3161-http.js';
import { parseArchive, verifyArchiveChain } from '../archive.js';
import { AUDIT_VERIFY_RESULT_SETTING_KEY, type PersistedVerifyResult } from '../verify-status.js';

const s3 = new S3Client({
  endpoint: process.env['S3_ENDPOINT'],
  region: process.env['S3_REGION'] ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? '',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? '',
  },
  forcePathStyle: true,
});

// Hard-Cap beim Laden eines Archiv-Objekts. Archiv-Segmente sind kleine
// NDJSON-Dateien (KB–einstellige MB); ein Objekt in dieser Größenordnung ist
// nie legitim. Ohne Cap würde ein manipuliertes/ersetztes Riesen-Objekt die
// CLI beim Buffer-Concat in den OOM treiben, BEVOR der SHA-Vergleich es als
// gefälscht entlarvt.
const MAX_ARCHIVE_OBJECT_BYTES = 512 * 1024 * 1024;

async function fetchObjectBytes(bucket: string, key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = result.Body as Readable;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.length;
    if (total > MAX_ARCHIVE_OBJECT_BYTES) {
      body.destroy();
      throw new Error(
        `Objekt überschreitet ${MAX_ARCHIVE_OBJECT_BYTES / 1024 / 1024} MB — kein legitimes Archiv-Segment (Manipulationsverdacht).`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const tsaUrl = process.env['TIMESTAMP_AUTHORITY_URL'];
  // C2: HTTP-Adapter statt Stub — wirft nicht unbedingt, prüft echte RFC-3161-Stamps.
  // createRfc3161Adapter zieht die aufgelösten Trust-Roots (Default + optionale
  // Operator-Roots aus TSA_TRUSTED_ROOTS_FILE) — sonst prüfte die CLI eine
  // Produktiv-TSA nur cryptoOk statt voll trust-verankert.
  const port = tsaUrl ? createRfc3161Adapter(tsaUrl) : new LocalTimestampAdapter();
  const evidence = new EvidenceService(port);

  // Produktivmodus → externe TSA verpflichtend (Self-Timestamp = harter Fail).
  const requireExternalTsa =
    process.env['NODE_ENV'] === 'production' || process.env['EVIDENCE_REQUIRE_TSA'] === 'true';

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, slug: true } });

  let allOk = true;
  for (const t of tenants) {
    process.stdout.write(`\n=== Tenant ${t.slug} (${t.name}) ===\n`);
    const result = await evidence.verifyChain(prisma, t.id, { requireExternalTsa });
    // Adapter-Modus IMMER ausweisen — die App-Uhr darf nie als „TSA-Zeit" durchgehen.
    process.stdout.write(
      `  TSA-Modus             : ${result.tsaMode === 'rfc3161' ? 'rfc3161 (externe TSA)' : 'local (Self-Timestamp — kein Drittnachweis)'}\n`,
    );
    process.stdout.write(`  Audit-Einträge geprüft: ${result.checked}\n`);
    process.stdout.write(`  Tages-Stempel geprüft : ${result.sealsChecked}\n`);
    if (result.tsaMode === 'rfc3161' && result.sealsChecked > 0) {
      const anchored = result.sealsTrustAnchored ?? 0;
      const mark = anchored < result.sealsChecked ? '⚠' : '✓';
      process.stdout.write(
        `  ${mark} Trust-verankert       : ${anchored}/${result.sealsChecked}` +
          (anchored < result.sealsChecked
            ? ` — restliche nur cryptoOk (Produktiv-TSA-Root via TSA_TRUSTED_ROOTS_FILE hinterlegen)\n`
            : `\n`),
      );
    }

    if (!result.ok) {
      allOk = false;
      for (const pb of result.policyBreaks) {
        process.stdout.write(`  ✗ POLICY: ${pb}\n`);
      }
      if (result.firstBreak) {
        process.stdout.write(`  ✗ HASH-CHAIN-BRUCH bei Audit-ID ${result.firstBreak.auditId}\n`);
        process.stdout.write(`    Zeitpunkt:  ${result.firstBreak.occurredAt.toISOString()}\n`);
        process.stdout.write(`    Erwartet:   ${result.firstBreak.expectedHash}\n`);
        process.stdout.write(`    Vorgefunden:${result.firstBreak.actualHash}\n`);
      }
      for (const b of result.sealBreaks) {
        process.stdout.write(
          `  ✗ TSA-Bruch am ${b.sealDate.toISOString().slice(0, 10)}: ${b.reason}\n`,
        );
      }
    } else if (result.checked === 0) {
      // N-3: Eine leere Kette ist KEIN Integritätsnachweis. Ohne persistierten
      // Monotonie-Anker (den nur der Worker führt) kann die CLI einen kompletten
      // Wipe nicht von einem frischen Tenant unterscheiden — daher explizit
      // warnen statt "intakt" zu melden.
      process.stdout.write(
        `  ⚠ Kette leer — keine Einträge geprüft (kein Integritätsnachweis; bei erwarteten Daten Wipe-Verdacht)\n`,
      );
    } else {
      process.stdout.write(`  ✓ Kette intakt\n`);
    }

    // Tail-Truncation-Anker: die höchste Audit-ID darf gegenüber dem letzten
    // Worker-Prüf-Lauf (tenant_setting `audit_verify_result`) NICHT schrumpfen —
    // audit_log ist append-only, die Archiv-Rotation entfernt nur die ÄLTESTEN
    // IDs. Ein konsistent gekürzter Chain-Schwanz (prev_hash-Links intakt) wäre
    // sonst für die CLI unsichtbar; nur der persistierte Anker entlarvt ihn.
    // Read-only: die CLI aktualisiert den Anker bewusst NICHT (Auditor-Tool).
    const anchorRow = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: t.id, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
      select: { value: true },
    });
    const anchor = (anchorRow?.value ?? null) as PersistedVerifyResult | null;
    const anchorLast = anchor?.lastAuditId ? BigInt(anchor.lastAuditId) : null;
    if (anchorLast !== null) {
      if (result.lastAuditId === null) {
        allOk = false;
        process.stdout.write(
          `  ✗ MONOTONIE: Kette ist leer, obwohl der letzte Prüf-Lauf bis Audit-ID ${anchorLast} kam — Spitzen-Einträge gelöscht (Tail-Truncation).\n`,
        );
      } else if (result.lastAuditId < anchorLast) {
        allOk = false;
        process.stdout.write(
          `  ✗ MONOTONIE: höchste Audit-ID ${result.lastAuditId} liegt UNTER dem Anker des letzten Prüf-Laufs (${anchorLast}) — die neuesten Einträge wurden gelöscht (Tail-Truncation).\n`,
        );
      } else {
        process.stdout.write(
          `  ✓ Monotonie-Anker: höchste Audit-ID ${result.lastAuditId} ≥ letzter Prüf-Lauf (${anchorLast})\n`,
        );
      }
    } else {
      process.stdout.write(
        `  ⚠ Kein Monotonie-Anker vorhanden (noch kein Worker-Prüf-Lauf persistiert) — Tail-Truncation nicht ausschließbar.\n`,
      );
    }

    // ----- Archive-Verifikation -----
    const archives = await prisma.auditArchive.findMany({
      where: { tenantId: t.id },
      orderBy: { fromAuditId: 'asc' },
    });
    if (archives.length === 0) {
      process.stdout.write(`  Archiv-Segmente: keine\n`);
      continue;
    }
    process.stdout.write(`  Archiv-Segmente: ${archives.length}\n`);
    for (const a of archives) {
      try {
        const bytes = await fetchObjectBytes(a.storageBucket, a.storageKey);
        const actualSha = createHash('sha256').update(bytes).digest();
        if (!actualSha.equals(Buffer.from(a.fileSha256))) {
          allOk = false;
          process.stdout.write(
            `  ✗ Archiv ${a.id} (${String(a.fromAuditId)}-${String(a.toAuditId)}): Datei-SHA-256 stimmt nicht!\n`,
          );
          continue;
        }
        const parsed = parseArchive(bytes);
        const check = verifyArchiveChain(parsed, {
          firstPrevHash: Buffer.from(a.firstPrevHash),
          lastThisHash: Buffer.from(a.lastThisHash),
        });
        if (!check.ok) {
          allOk = false;
          process.stdout.write(
            `  ✗ Archiv ${a.id} (${String(a.fromAuditId)}-${String(a.toAuditId)}): ${check.reason}` +
              (check.brokenAtId ? ` bei ID ${check.brokenAtId}` : '') +
              '\n',
          );
        } else {
          process.stdout.write(
            `  ✓ Archiv ${String(a.fromAuditId)}-${String(a.toAuditId)} (${a.entryCount} Einträge, ${a.mode}, ${(Number(a.fileSizeBytes) / 1024).toFixed(1)} KB)\n`,
          );
        }
      } catch (e) {
        allOk = false;
        process.stdout.write(
          `  ✗ Archiv ${a.id} (${String(a.fromAuditId)}-${String(a.toAuditId)}): Datei nicht lesbar — ${(e as Error).message}\n`,
        );
      }
    }
  }

  await prisma.$disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('verify:chain fehlgeschlagen:', err);
  process.exit(2);
});
