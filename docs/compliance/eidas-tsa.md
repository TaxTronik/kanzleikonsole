# TSA-Konfiguration und eIDAS-Zeitstempel

Stand: 2026-08-23

taxtronik nutzt RFC-3161-Zeitstempel für zwei gekoppelte Nachweise: rollende
Audit-Anker im Regelfall alle zwei Sekunden und eine zusätzliche tägliche
Versiegelung der Tageskettenspitze. Diese Datei klärt:

- Welche TSAs sind unterstützt?
- Was passiert bei TSA-Ausfall?
- Welche Beweiswerte haben die verschiedenen Stempel-Arten?

---

## TSA-Provider

### Konfiguration

- ENV-Variable `TIMESTAMP_AUTHORITY_URL` (siehe [`.env.example`](../../.env.example))
- Pro-Tenant-Override via `tenant_setting.evidence.tsa` (`providerId` für
  bekannte Provider oder `customUrl` für eine eigene öffentlich auflösbare
  TSA; private/interne Ziele werden abgelehnt)
- Vertrauensanker für die kryptografische Antwortprüfung: GlobalSign Root R6
  ist eingebaut. Für jeden Nicht-GlobalSign-Anbieter muss der Betreiber dessen
  self-signed Root out-of-band als PEM-Datei bereitstellen und den Dateipfad
  über `TSA_TRUSTED_ROOTS_FILE` konfigurieren. Die zusätzlichen Roots werden
  mit dem eingebauten GlobalSign-Root zusammengeführt und pro Prozess gecacht.
  Im Docker-Stack bezeichnet `TSA_TRUSTED_ROOTS_HOST_DIR` das read-only
  eingehängte Host-Verzeichnis; `TSA_TRUSTED_ROOTS_FILE` muss auf die konkrete
  PEM-Datei unter `/etc/taxtronik/tsa-roots/` im Container zeigen.
- Bei externer RFC-3161-Nutzung werden Antworten für rollende Anker und
  Tagesversiegelungen nur nach Prüfung von Signatur, Datenbindung,
  Timestamping-Zertifikatszweck und der Kette bis zu einem konfigurierten
  Trust-Anchor persistiert. Ein korrekt signiertes Token einer unbekannten CA
  ist ausdrücklich kein erfolgreicher Nachweis. Der unten beschriebene lokale
  Development-/Legacy-Pfad ist kein solcher externer Nachweis. Eine
  Sperrstatusprüfung über OCSP/CRL ist derzeit nicht implementiert; dieses
  verbleibende Risiko muss der Betreiber bei der TSA-Auswahl berücksichtigen.

### Unterstützte Provider

Quelle: [`packages/evidence/src/providers/tsa-providers.ts`](../../packages/evidence/src/providers/tsa-providers.ts)
(in der Admin-UI auswählbar):

| `providerId` | TSA-URL                                           | Kosten      | Produktzusage zur eIDAS-Qualifikation             |
| ------------ | ------------------------------------------------- | ----------- | ------------------------------------------------- |
| `freetsa`    | `https://freetsa.org/tsr`                         | kostenlos   | Nein — Test-/Dev-Betrieb                          |
| `digicert`   | `http://timestamp.digicert.com`                   | kostenlos   | Nein                                              |
| `sectigo`    | `http://timestamp.sectigo.com`                    | kostenlos   | Nein                                              |
| `globalsign` | `http://timestamp.globalsign.com/tsa/r6advanced1` | kostenlos   | Nein — externer RFC-3161-Default                  |
| `apple`      | `http://timestamp.apple.com/ts01`                 | kostenlos   | Nein                                              |
| `dtrust`     | `https://tsa.d-trust.net/timestamp`               | kommerziell | Keine; konkreten Vertrag/Dienst in der TSL prüfen |
| `swisscom`   | `http://tsa.swisscom.com/…`                       | kommerziell | Keine; konkreten Vertrag/Dienst separat prüfen    |
| `custom`     | eigene öffentliche HTTP(S)-URL                    | —           | Keine; Betreiber-Verantwortung                    |

## Beweiswert und Betreiberentscheidung

Art. 41 Abs. 1 der
[eIDAS-Verordnung](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32014R0910)
verbietet es, einem elektronischen Zeitstempel Rechtswirkung oder
Beweiszulässigkeit allein deshalb abzusprechen, weil er nicht qualifiziert ist.
Für einen **qualifizierten** elektronischen Zeitstempel gilt nach Art. 41
Abs. 2 zusätzlich die gesetzliche Vermutung der Richtigkeit von Datum und Zeit
sowie der Unversehrtheit der gebundenen Daten.

Deshalb gilt für TaxTronik:

- GlobalSign ist der ohne kommerziellen Vertrag nutzbare externe Default. Er
  liefert einen unabhängigen RFC-3161-Nachweis, wird von TaxTronik aber **nicht
  als qualifizierter eIDAS-Zeitstempel zugesagt**.
- D-Trust beziehungsweise ein anderer in der EU-Vertrauensliste geführter
  qualifizierter Dienst kann gewählt werden, wenn die Kanzlei die
  Vermutungswirkung oder eine vertragliche/prüferische Vorgabe benötigt. Damit
  dessen Antworten vollständig trust-verankert als `valid` geprüft werden,
  muss zusätzlich der passende Root über `TSA_TRUSTED_ROOTS_FILE` hinterlegt
  und unabhängig verifiziert werden.
- Ob ein qualifizierter Dienst für einen konkreten Prozess erforderlich ist,
  ist eine rechtliche und organisatorische Betreiberentscheidung. TaxTronik
  behauptet keine pauschale GoBD-Pflicht für qualifizierte Zeitstempel.
- Die Provider-Eigenschaft muss der Betreiber bei Vertragsschluss und
  regelmäßig anhand der EU-Vertrauensliste prüfen; die Tabelle ist kein
  qualifizierter Vertrauenslisten-Nachweis.

## TSA-Ausfall — tatsächliches Fallback-Verhalten

`audit-anchor` und `evidence-seal` verwenden denselben Auswahlpfad
(`apps/worker/src/tsa-port.ts`). In Produktion gilt:

1. Tenant-Einstellung → `TIMESTAMP_AUTHORITY_URL` → GlobalSign-Default.
2. Produktion fällt **nie** auf lokale Selbstzeit zurück. Ist keine externe
   URL auflösbar oder lehnt der SSRF-/Zertifikats-Guard das Ziel ab, schlägt
   der Zeitstempelversuch fehl und wird mit Backoff wiederholt.
3. Rollende Anker und tägliche Versiegelungen werden erst nach vollständig
   erfolgreicher Trust-Anchor-Prüfung persistiert. Bei einem temporären Fehler
   bleibt ein sichtbarer Rückstand bestehen; ein Folgelauf versucht den noch
   offenen Zeitraum erneut.
4. `LocalTimestampAdapter` ist ausschließlich ein Development-/Legacy-Pfad.
   Er belegt keinen unabhängigen Existenzzeitpunkt und wird vom rollenden
   Produktionsanker ausdrücklich abgelehnt.

## Monitoring

- `/staff/admin/settings/integrations` zeigt den TSA-Status pro Tenant via
  `checkTsaForTenant` (siehe [`apps/web/src/server/health/checks.ts`](../../apps/web/src/server/health/checks.ts)).
  Statusprüfung und Worker verwenden dieselbe Auswahlreihenfolge:
  Tenant-Einstellung → `TIMESTAMP_AUTHORITY_URL` → GlobalSign-Default.
  Der Status ist nur grün, wenn ein echter Test-Token nicht nur `granted`
  meldet, sondern auch an den zufälligen Test-Hash und einen konfigurierten
  Trust-Anchor gebunden verifiziert wird. Derselbe vollständige Roundtrip gilt
  für „Verbindung testen“ in den TSA-Einstellungen.
- Operations-Checkliste: laufend den Anchor-Rückstand in der Admin-Ansicht und
  täglich die zusätzliche `evidence-seal`-Abdeckung je Tenant prüfen. Die
  folgende Abfrage erfasst vergangene UTC-Tage mit Audit-Ereignissen; Tage ohne
  Ereignis benötigen keinen Seal:
  ```sql
  WITH event_days AS (
    SELECT tenant_id, (occurred_at AT TIME ZONE 'UTC')::date AS seal_date
    FROM audit_log
    WHERE occurred_at >= (
            date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            - INTERVAL '7 days'
          ) AT TIME ZONE 'UTC'
      AND occurred_at < (
            date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            AT TIME ZONE 'UTC'
          )
    GROUP BY tenant_id, (occurred_at AT TIME ZONE 'UTC')::date
  )
  SELECT event_days.tenant_id,
         event_days.seal_date,
         audit_seal.id IS NULL AS missing_seal,
         audit_seal.id IS NOT NULL
           AND audit_seal.tsa_response_blob IS NULL AS missing_stamp
  FROM event_days
  LEFT JOIN audit_seal
    ON audit_seal.tenant_id = event_days.tenant_id
   AND audit_seal.seal_date = event_days.seal_date
  ORDER BY event_days.tenant_id, event_days.seal_date;
  ```
  `missing_seal = true` bedeutet, dass für einen ereignisbehafteten Tag noch
  keine Seal-Zeile existiert. `missing_stamp = true` bedeutet: Die Seal-Zeile
  existiert, aber ihr fehlt der unabhängige RFC-3161-Nachweis. Beides bedeutet
  **nicht**, dass vorhandene elektronische Aufzeichnungen automatisch
  unzulässig oder wertlos wären.
  Der Operator sollte den TSA-Anschluss prüfen. Fehlgeschlagene neue
  Versiegelungsversuche hinterlassen keine Seal-Zeile und werden im nächsten
  `evidence-seal`-Lauf erneut versucht. Bereits vorhandene ältere Seal-Zeilen
  mit `tsa_response_blob IS NULL` gelten für den Backfill dagegen als belegt
  und werden derzeit **nicht automatisch nachgestempelt**; dafür fehlt noch ein
  kontrollierter, mit der Insert-only-Historie vereinbarer Reparaturpfad. Einen
  dedizierten manuellen Re-Seal-Trigger gibt es ebenfalls nicht. Manuell
  anstoßbar sind: die Audit-Archiv-Rotation unter `/staff/admin/archive` und
  die Chain-Verifikation über den „Jetzt prüfen"-Button unter
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
