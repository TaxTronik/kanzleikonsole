# TSA-Konfiguration und eIDAS-Zeitstempel

Stand: 2026-05-14

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

| `providerId` | TSA-URL | Qualifiziert nach eIDAS? |
|---|---|---|
| `dtrust` | `http://timestamp.d-trust.net/tsa` | Ja — Qualified Trust Service Provider, BSI-anerkannt |
| `swisssign` | `http://tsa.swisssign.net` | Ja (eIDAS-Anerkennung in EU) |
| `freetsa` | `https://freetsa.org/tsr` | Nein — Best-effort, nicht beweistauglich |
| Custom-URL | beliebig | Operator-Verantwortung |

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

- `/staff/admin/health` zeigt den TSA-Status pro Tenant via
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
  Operator sollte den TSA-Anschluss prüfen und einen manuellen Re-Seal
  triggern (über die Admin-UI).

## PoA-Signatur (eIDAS Art. 26 — fortgeschrittene elektronische Signatur)

PoA-OTP-Signatur ist **fortgeschritten**, nicht **qualifiziert**. Das ist im
deutschen Berufsrecht für Steuerberatervollmachten i. d. R. ausreichend,
aber:

- Bei strittigen Mandaten ist eine qualifizierte Signatur (Smartcard,
  z. B. D-Trust QES) sicherer.
- taxtronik hat einen `EidasSignaturePort`-Interface vorgesehen — die
  konkrete QES-Integration (Smartcard-Reader-Anbindung) ist nicht Teil
  des MVP.
