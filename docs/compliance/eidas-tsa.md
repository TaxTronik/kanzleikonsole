# TSA-Konfiguration und eIDAS-Zeitstempel

Stand: 2026-06-10

taxtronik nutzt RFC-3161-Zeitstempel für die tägliche Versiegelung des
Audit-Hash-Chain-Top-Hashes. Diese Datei klärt:

- Welche TSAs sind unterstützt?
- Was passiert bei TSA-Ausfall?
- Welche Beweiswerte haben die verschiedenen Stempel-Arten?

---

## TSA-Provider

### Konfiguration

- ENV-Variable `TIMESTAMP_AUTHORITY_URL` (siehe [`.env.example`](../../.env.example))
- Pro-Tenant-Override via `tenant_setting.evidence.tsa` (`providerId` für
  bekannte Provider oder `customUrl` für eigene TSAs)

### Unterstützte Provider

Quelle: [`packages/evidence/src/providers/tsa-providers.ts`](../../packages/evidence/src/providers/tsa-providers.ts)
(in der Admin-UI auswählbar):

| `providerId` | TSA-URL                                           | Kosten      | Qualifiziert nach eIDAS?                           |
| ------------ | ------------------------------------------------- | ----------- | -------------------------------------------------- |
| `freetsa`    | `https://freetsa.org/tsr`                         | kostenlos   | Nein — Test-/Dev-Betrieb                           |
| `digicert`   | `http://timestamp.digicert.com`                   | kostenlos   | Nein (US-CA)                                       |
| `sectigo`    | `http://timestamp.sectigo.com`                    | kostenlos   | Nein                                               |
| `globalsign` | `http://timestamp.globalsign.com/tsa/r6advanced1` | kostenlos   | Nein — EU-ansässig, Default                        |
| `apple`      | `http://timestamp.apple.com/ts01`                 | kostenlos   | Nein                                               |
| `dtrust`     | `https://tsa.d-trust.net/timestamp`               | kommerziell | **Ja** — Bundesdruckerei, empfohlen für Produktion |
| `swisscom`   | `http://tsa.swisscom.com/…`                       | kommerziell | **Ja** (CH)                                        |
| `custom`     | eigene URL                                        | —           | Operator-Verantwortung                             |

## TSA-Ausfall — Fallback-Verhalten

`evidence-seal` ruft beim Tagesabschluss eine TSA. Bei Failure:

1. **Per-Tenant-TSA gesetzt → fehlgeschlagen**: Top-Hash wird OHNE externen
   Stempel in `audit_seal.tsa_response_blob = NULL` persistiert. Im
   nächsten Lauf wird der versuchsweise erneut gestempelt (bis zur
   Versiegelung kann der Tag durch einen späteren Stempel beweistauglich
   werden, das ist aber Stand „best effort").
2. **Keine TSA konfiguriert**: `LocalTimestampAdapter` läuft, schreibt
   einen LOKALEN SHA-256-Stempel. Das ist **NICHT eIDAS-qualifiziert** —
   es weist lediglich nach, dass die Versiegelung stattgefunden hat, kann
   aber nicht beweisen, **wann** sie stattgefunden hat (kein vertrauens-
   würdiger Dritter im Bunde).

> **Wichtig**: Eine Installation ohne externen TSA-Anschluss erfüllt nicht
> die Anforderungen an einen qualifizierten Zeitstempel nach Art. 41 eIDAS-
> Verordnung (VO (EU) Nr. 910/2014). Der lokale Self-Timestamp ist **nicht
> qualifiziert** und sollte nur in Test-/Dev-Umgebungen verwendet werden.
> Für produktive Steuerberater-Kanzleien ist ein qualifizierter TSA-
> Provider (z. B. D-Trust) Pflicht für die Aufrechterhaltung der GoBD-
> Beweiskraft im Streitfall.

## Monitoring

- `/staff/admin/settings/integrations` zeigt den TSA-Status pro Tenant via
  `checkTsaForTenant` (siehe [`apps/web/src/server/health/checks.ts`](../../apps/web/src/server/health/checks.ts)).
- Operations-Checkliste: täglich prüfen, dass `evidence-seal` für jeden
  Tenant einen TSA-Stempel geschrieben hat. SQL:
  ```sql
  SELECT tenant_id, seal_date, tsa_response_blob IS NULL AS missing_stamp
  FROM audit_seal
  WHERE seal_date >= CURRENT_DATE - INTERVAL '7 days'
  ORDER BY tenant_id, seal_date;
  ```
  Tage mit `missing_stamp = true` sind aus eIDAS-Sicht nicht beweistauglich.
  Operator sollte den TSA-Anschluss prüfen — fehlende Stempel holt der
  nächste `evidence-seal`-Lauf automatisch nach (Backfill); einen
  dedizierten manuellen Re-Seal-Trigger gibt es nicht. Manuell anstoßbar
  sind: die Audit-Archiv-Rotation unter `/staff/admin/archive` und die
  Chain-Verifikation über den „Jetzt prüfen"-Button unter
  `/staff/admin/audit` (läuft als Hintergrund-Job, Ergebnis wird
  persistiert angezeigt).

## PoA-Bestätigungsprozess und eIDAS-Einordnung

Der PoA-Prozess bindet Magic-Link, E-Mail-Code, ausdrückliche Bestätigung und
den exakten Inhalts-/Dokumentversions-Snapshot in einer Beweisspur. Das erhöht
den Beweiswert einer elektronischen Erklärung, ist aber **ohne unabhängige
Identitätsfeststellung und Konformitätsbewertung nicht als fortgeschrittene oder
qualifizierte elektronische Signatur zugesagt**. Magic-Link und Code werden an
dasselbe Postfach gesendet und stellen daher keine unabhängigen Faktoren dar.

Wenn ein konkreter Vorgang AES oder QES erfordert, ist ein dafür bewerteter
Signaturdienst einzubinden. Eine solche Integration ist derzeit nicht
implementiert (siehe ADR-0009).
