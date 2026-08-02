# Technische Modulbeschreibung: Dokumentenarchiv

## Zweck

Revisionssichere Ablage aller Mandanten- und Kanzlei-Dokumente mit
Schutzstufen (GoBD/GwG/ohne), Versionierung, Virenscan vor Annahme und
kontrollierter Mandanten-Freigabe.

## Datenmodell

`Document` (Titel, Typ/Klassifikation, clientId optional, Freigabe
`sharedWithClientAt`, Soft-Delete-Felder) → `DocumentVersion` (bucket/key,
SHA-256, Größe, `immutable`, Scan-Status; unique je documentId+versionNo) →
`DocumentFolder` (Baum; Löschen reparentiert, nie kaskadierend) →
`DocumentType` (Admin-gepflegt; Schutzstufe und bei GoBD die 6-/8-/10-
Jahresfrist bei Anlage fixiert, 7 Kern-Typen read-only).

## Programminterne Kontrollen

| Kontrolle          | Umsetzung                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Annahme-Pipeline   | zentral `packages/storage/src/service.ts`: ClamAV-Scan **synchron vor** jedem Upload (INFECTED→422, Scanner-Fehler→502, fail-closed — nichts wird gespeichert), SHA-256, Magic-Byte-MIME-Vorrang, 25-MiB-Cap (`MAX_UPLOAD_BYTES`; Teilbereiche 10 MB)                                                                                      |
| Unveränderlichkeit | Object-Lock je Stufe: GOBD→COMPLIANCE mit typabhängig 6/8/10 J. (§ 147 AO/§ 14b UStG), GWG→GOVERNANCE und fachlicher Lösch-Queue; DB-Trigger `document_version_immutable_protect` (auch Owner); Herabstufung/Fristverkürzung sowie GWG→GOBD blockiert, Höherstufung aus NONE oder GOBD-Fristverlängerung re-stored in den gelockten Bucket |
| Soft-Delete        | nur Sichtbarkeit (Papierkorb, wiederherstellbar), keine S3-Löschung; endgültige Vernichtung ausschließlich im GwG-Verfahren (Admin-Review-Queue, je Beleg bestätigt, Audit `gwg.evidence.destroy`)                                                                                                                                         |
| Freigabe           | serverseitig erzwungen: Portal-Liste/-Download/-Preview filtern `sharedWithClientAt != null` + Session-clientId; Staff-Freigabe nur für Mandanten-Dokumente, auditiert                                                                                                                                                                     |
| Auslieferung       | app-proxied (Object-Store nie öffentlich, 127.0.0.1-Bind); Inline-Preview-Whitelist (pdf/Bilder/text-plain; html/svg/js nie inline), `nosniff` + CSP `sandbox` für text/plain, Dateinamen-Header sanitisiert, ZIP-Export mit Größen-/Parallel-Caps und Zip-Slip-Härtung                                                                    |
| Zugriff            | Staff: Tenant-Filter + RESTRICTED-Zuständigkeit (Liste, Download, Preview, Detailseite); Portal: nur eigene, freigegebene Dokumente                                                                                                                                                                                                        |
| Protokollierung    | `document.upload/.download/.preview/.delete/.restore/.retag/.share/.unshare/.move_folder/.acknowledge`, `document.version.add`, Ordner-/Typ-Events, GwG-Vernichtungs-Events                                                                                                                                                                |

## Upload-Wege (alle über die zentrale Pipeline)

Staff-Explorer (+ neue Version, mit Race-Schutz 409), Portal-Upload
(Feature-Flag, Rate-Limit, auto-geteilt), Formular-Anhänge (10 MB),
GwG-Onboarding (anonym per Token, GWG-Bucket), Rechnungs-PDFs
(EXTERNAL-Upload + ZUGFeRD-Archiv → GOBD), Steuererklärungs-PDFs (GOBD).

## Traceability

| Anforderung                                 | Implementierung                      | Test                                                                                              |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Kein Inline-XSS über Dokumente              | preview-mime Whitelist + CSP sandbox | `server/storage/__tests__/preview-mime.test.ts`                                                   |
| ZIP-Export sicher + begrenzt                | export/zip                           | `server/export/__tests__/zip.test.ts`                                                             |
| GwG-Fristen + Lösch-Queue                   | server/gwg/retention                 | `server/gwg/__tests__/retention.test.ts`, Worker-Test gwg-expiry-check                            |
| DSGVO-Anonymisierung respektiert GwG-Belege | dsgvo/client-retention               | `server/dsgvo/__tests__/client-retention.test.ts`                                                 |
| Rechnungsarchiv unveränderlich + idempotent | invoicing/archive                    | `invoicing/__tests__/archive.test.ts`                                                             |
| Mandantentrennung                           | RLS + Filter                         | `rls-cross-tenant.test.ts` (Document-Fall)                                                        |
| Scan-/Größen-Fehlerpfade end-to-end         | upload-helpers + commit-Routen       | Sicherheitsaudit 2026-06 (verifiziert); Unit-Lücke in packages/storage dokumentiert (Gap-Analyse) |

## Bekannte Grenzen

- Magic-Bytes überschreiben den Client-MIME, lehnen unbekannte Formate aber
  nicht ab (Preview-Whitelist mildert).
- Verwaiste, gelockte S3-Objekte bei DB-Fehlern nach Commit (geloggt, kein
  Abgleich-Job); kein Streaming-Multipart (RAM-Puffer bis Cap).
- GwG-Frühvernichtung vor Lock-Ablauf (GOVERNANCE-Bypass) nicht implementiert.
