-- =============================================================================
-- iter103 — eIDAS-Bindung der Vollmachts-Signatur (Art. 26 lit. d).
--
-- Bislang wurde beim Signieren nur signedAt/IP/User-Agent gespeichert; welcher
-- Inhalt (welche PDF-Version) tatsächlich unterschrieben wurde, war NICHT
-- kryptografisch festgehalten. Zwei additive, nullable Spalten binden den
-- Signaturakt an den SHA-256 des signierten Inhalts und an die konkret
-- signierte Dokumentversion:
--   - signed_content_sha256: SHA-256 des signierten Inhalts (extern hinterlegtes
--     PDF: Hash der aktuellen Dokumentversion; In-App-Vollmacht: Hash des
--     scope-Texts).
--   - signed_document_version_id: Referenz auf die signierte document_version
--     (nur im Extern-PDF-Modus gesetzt).
--
-- Rein additiv, keine FK-Constraint (der Beweiswert soll eine spätere
-- Version-Löschung überleben; die new-version-Route sperrt ohnehin die
-- Weiterversionierung signierter Dokumente). Kein Backfill für Altbestand.
-- =============================================================================

ALTER TABLE "power_of_attorney" ADD COLUMN "signed_content_sha256" BYTEA;
ALTER TABLE "power_of_attorney" ADD COLUMN "signed_document_version_id" UUID;
