# Security-Audit: Mandanten-Portal (internetexponierte Fläche)

**Datum:** 2026-06-10 · **Methodik:** drei unabhängige adversariale
Code-Reviews (Auth-Flows · Upload-/Dokumenten-Pipeline · Portal-API/IDOR),
jeder Befund am Code verifiziert (Datei/Zeile), keine Vermutungen aus
Dateinamen. Vorbereitung auf einen externen Pentest.

## Gesamtergebnis

**Keine kritischen oder hohen Befunde.** Die Portal-Fläche ist durchgängig
gegen die Session-Identität (nicht nur den Tenant) autorisiert; der kritische
Fall „Mandant A ↔ Mandant B desselben Tenants" (den RLS nicht abdeckt) ist
überall explizit geschlossen. Die im Code dokumentierten Härtungen (H2, H7,
M-1, P-7, S4, S9, S12 …) entsprechen real vorhandenen, korrekten Checks.

Strukturelle Stärken, die ganze Angriffsklassen eliminieren:

- **Kein Presigned-Direct-Upload, kein asynchroner Scan:** alle Uploads sind
  app-proxied; ClamAV läuft **synchron vor** dem DB-Insert (fail-closed bei
  Scanner-Fehler). Commit-vor-Scan-Races und direkte Objekt-Links existieren
  nicht; der S3-Port ist nur auf 127.0.0.1 gebunden.
- **Magic-Link:** 32-Byte-Token, Hash-Lookup, atomarer One-Time-Consume,
  POST-Consume-Pattern (kein Verbrauch durch Mail-Scanner-Prefetch),
  Anti-Enumeration mit Zufalls-Delay auf allen stillen Pfaden.
- **Kein `$queryRawUnsafe`/`$executeRawUnsafe` mit Interpolation** im
  Portal-Pfad; Markdown-/Mail-Rendering escaped User-Input konsequent
  (inkl. CRLF-Header-Strip).
- Rate-Limits fail-closed in Produktion; X-Forwarded-For wird ohne
  `TRUST_PROXY_REQUIRED=true` gar nicht erst vertraut.

## Befunde (alle niedrig/informativ)

| # | Sev. | Befund | Ort | Empfehlung |
|---|------|--------|-----|------------|
| 1 | Niedrig | **Tote Quarantäne-Konfiguration**: init-storage.sh legt weiterhin CORS (`PUT/GET/HEAD`) + Lifecycle auf dem `quarantine`-Bucket an — Relikt der aufgegebenen Presigned-Architektur; `commitDocument()` in packages/storage ist toter Code ohne Aufrufer. Nur relevant, falls der S3-Port je exponiert würde. | `infra/scripts/init-storage.sh:73-125`, `packages/storage/src/service.ts:440` | CORS-Block, Quarantäne-Bucket-Anlage und Dead Code entfernen — verhindert versehentliche Reaktivierung eines unscannbaren, browser-beschreibbaren Pfads. **Umgesetzt am 2026-06-10:** CORS-Block, Quarantäne-Bucket, `commitDocument()`/`CommitDocumentInput`, `S3_BUCKET_QUARANTINE` (env/turbo/compose) und die ungenutzte presigner-Dependency entfernt; ADR-0005 + Pen-Test-Doku angeglichen. |
| 2 | Niedrig | **OTP-Fenster wächst durch Re-Issue**: pro Signatur-OTP 5 Versuche, Re-Issue setzt den Zähler zurück → mit Issue-Cap 10 max. ~50 Versuche gegen 10⁶ (0,005 %, zusätzlich IP-Limit 20/10 min). Praktisch nicht ausnutzbar. | `poa/actions.ts:333-470` | Optional: lebenszyklus-weiter Fehlversuchs-Cap (z. B. 15 über alle Re-Issues). **Umgesetzt am 2026-06-10:** `signingOtpAttemptsTotal` (Migration iter84) zählt über alle Re-Issues, Cap 15, Reset nur beim Versand eines neuen Signatur-Tokens. |
| 3 | Niedrig | **iCal-Feed-Token ohne Einzelwiderruf**: statischer HMAC über `contactId`, Revocation nur global via AUTH_SECRET-Rotation. Deaktivierte Kontakte → 404 (gut); Inhalt nur Termine. | `server/ical/feed.ts:27-44` | Optional: `icalTokenVersion` pro Kontakt in den HMAC aufnehmen. **Umgesetzt am 2026-06-10:** `clientContact.icalTokenVersion` (Migration iter84) ist Teil des HMAC-Payloads; die Route vergleicht gegen den DB-Stand — Versions-Bump = Einzelwiderruf. Alte zweiteilige Tokens sind seit dem Deploy ungültig (Kalender-Abos einmalig neu abonnieren). |
| 4 | Info | **`text/plain` inline-Preview** hängt allein an `X-Content-Type-Options: nosniff` (greift via `/:path*` auch auf API-Responses). Funktioniert in aktuellen Browsern — aber Single-Point. | `server/storage/preview-mime.ts:20-27` | Optional: `text/plain` als `attachment` oder per-Response `CSP: sandbox`. **Umgesetzt am 2026-06-10:** `previewSecurityHeaders()` setzt `Content-Security-Policy: sandbox` auf `text/plain`-Streams (Staff- und Portal-Preview-Route); inline-UX bleibt erhalten. |
| 5 | Info | **Magic-Link-Token im URL-Query** der Verify-Seite; interner „Neuen Link anfordern"-Link könnte den Referer (same-origin) mit Token senden. One-Time-Use + POST-Consume entschärfen das weitgehend. | `portal/(auth)/login/verify/page.tsx:28,59` | Optional: `referrerPolicy="no-referrer"` am Link bzw. globale Referrer-Policy. **Umgesetzt am 2026-06-10:** `referrerPolicy="no-referrer"` an beiden internen Links; der Route-Header `Referrer-Policy: no-referrer` (next.config H-3) bestand bereits — jetzt doppelt abgesichert. |
| 6 | Info | **Kein Read-Rate-Limit** auf Portal-Download/Preview (nur eigene, freigegebene Dokumente; schreibt pro Abruf einen Audit-Eintrag → Audit-Spam/Last möglich). | `api/portal/documents/[id]/*` | Optional: leichtes Read-Limit. **Umgesetzt am 2026-06-10:** `checkPortalReadLimit` (gemeinsamer Bucket pro Session-Kontakt, 240/10 min — großzügig: eine Preview kostet 2 Requests) greift in beiden Routen VOR dem DB-Zugriff/Audit-Write; Überschreitung → 429 mit `Retry-After`. Tests in `api/portal/documents/__tests__`. |
| 7 | Info | **ZIP-Bomben** werden gespeichert, aber nie app-seitig entpackt (nur durchgestreamt; ClamAV scannt mit eigenen Limits; 100-MB-Cap). Akzeptiertes Restrisiko. | `packages/storage/src/service.ts:131` | Keine Maßnahme zwingend. |

## Abdeckung (geprüft und sauber)

- **Auth:** Magic-Link-Lebenszyklus komplett, Session-Trennung Staff/Portal
  (`__Host-`-Cookies, getrennte Auth.js-Instanzen, per-Request-Revalidierung,
  Redis-Revocation), Open-Redirect (`safePortalReturnTo`), Host-Header
  (Mail-Links nur aus env-Base-URLs), Lockout-Design (distinkte IPs, kein
  Fremd-Lockout), TOTP-Replay-Schutz (Redis SET NX, fail-closed).
- **Portal-API:** alle 12 Pages, 4 Route-Handler, 8 Server-Action-Dateien +
  GwG-Onboarding — Session-clientId-Scoping lückenlos; Mass-Assignment durch
  `.strict()`-/Enum-Schemas geschlossen; Fehlerpfade ohne Internals.
- **Dokumente:** Größenlimits dreifach, Magic-Byte-Vorrang vor Client-MIME,
  SVG/HTML nie inline, Header-Injection über Dateinamen gestrippt, S3-Keys
  serverseitig generiert, Object-Lock/Retention nicht umgehbar, Freigabe-Flag
  serverseitig erzwungen.

## Einordnung

Vor einem externen Pentest sollte Befund 1 (Dead-Config) bereinigt werden —
nicht wegen akuter Ausnutzbarkeit, sondern damit der Pentest-Bericht nicht
mit Architektur-Archäologie verstopft wird. Befunde 2–7 sind bewusste oder
vertretbare Restrisiken; Härtung lohnt opportunistisch.

**Stand 2026-06-10:** Befunde 1–6 sind umgesetzt (Vermerke in der Tabelle;
Befund 1 als Dead-Config-Bereinigung, Befunde 2–5 mit Migration iter84 und
Tests in `server/ical/__tests__`, `server/storage/__tests__` und
`staff/(protected)/poa/__tests__`, Befund 6 als Read-Rate-Limit mit Tests in
`api/portal/documents/__tests__`). Offen bleibt nur Befund 7 (akzeptiertes
Restrisiko).
