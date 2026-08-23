# Eingefrorene Prüfumgebung für eine Softwareprüfung

Stand der Anleitung: 2026-08-23

Diese Anleitung beschreibt, wie für einen abgegrenzten TaxTronik-Release eine
reproduzierbare und während der Prüfung kontrollierte Umgebung vorbereitet,
eingefroren und dokumentiert werden kann. Sie unterstützt die in der
[PS-880-Readiness-Analyse](../compliance/idw-ps880-pruefungsbereitschaft.md)
identifizierte Maßnahme. Sie ist **kein Nachweis**, dass eine solche Umgebung
bereits eingerichtet wurde, und weder Prüfungsbericht noch
Softwarebescheinigung.

Die konkrete Ausgestaltung ist vor Beginn mit dem beauftragten Prüfer und dem
vereinbarten Prüfungsgegenstand abzustimmen. Geheimnisse, Echtdaten und
personenbezogene Daten gehören nicht in diese Dokumentation.

## 1. Prüfungsgegenstand festlegen

Vor der technischen Bereitstellung werden Scope, Release und erwartete
Testfälle schriftlich festgelegt. Nicht geprüfte Module und externe Dienste
werden ausdrücklich abgegrenzt.

| Merkmal                                      | Eintrag für die konkrete Prüfung |
| -------------------------------------------- | -------------------------------- |
| Prüfungsauftrag / Referenz                   | `…`                              |
| Stichtag oder Prüfungszeitraum               | `…`                              |
| Produktname und Edition                      | `…`                              |
| In-Scope-Module und Funktionen               | `…`                              |
| Ausgeschlossene Module und Funktionen        | `…`                              |
| Einbezogene Schnittstellen / Fremdsysteme    | `…`                              |
| Vereinbarte Mengen- und Performance-Annahmen | `…`                              |
| Ansprechpartner des Prüfers                  | `…`                              |
| Technisch verantwortliche Person             | `…`                              |
| Fachlich verantwortliche Person              | `…`                              |

Fachliche Regeln und ihre Review-Stände werden aus dem
[Fachkatalog](../fachkatalog/README.md) übernommen. Ein technischer
Umsetzungsstatus und eine fachliche Freigabe sind getrennt auszuweisen;
`unreviewed` darf nicht als Zustimmung interpretiert werden.

## 2. Identität der Umgebung erfassen

Die folgenden Werte werden aus der tatsächlich bereitgestellten Umgebung
ausgelesen, nicht aus einem Plan oder einem früheren Lauf kopiert.

| Merkmal                                             | Ermittelter Wert / Nachweis |
| --------------------------------------------------- | --------------------------- |
| Eindeutige Umgebungs-ID                             | `…`                         |
| Bereitgestellt am (UTC)                             | `…`                         |
| Release-Tag                                         | `v…`                        |
| Commit-SHA (vollständig)                            | `…`                         |
| Web-Image inkl. `sha256:`-Digest                    | `…`                         |
| Worker-Image inkl. `sha256:`-Digest                 | `…`                         |
| Signiertes Update-Manifest: Pfad/URL und SHA-256    | `…`                         |
| Signaturdatei: Pfad/URL und SHA-256                 | `…`                         |
| Verwendete Compose-/Deployment-Dateien und SHA-256  | `…`                         |
| Betriebssystem / Kernel / Architektur               | `…`                         |
| Container-Runtime und Compose-Version               | `…`                         |
| PostgreSQL-Version                                  | `…`                         |
| Redis-Version                                       | `…`                         |
| SeaweedFS-/S3-Version und Object-Lock-Konfiguration | `…`                         |
| Browser-/Client-Versionen für UI-Tests              | `…`                         |
| Zeitzone, Locale und Systemzeitquelle               | `…`                         |
| CPU, RAM und Speicherkontingent                     | `…`                         |
| Netzwerk- und DNS-Rahmen                            | `…`                         |

Die Image-Digests müssen mit dem signierten Update-Manifest und der
[Release-Evidence](./ps880-release-evidence.md) übereinstimmen. Ein
SemVer-Tag ohne Digest bindet keine unveränderlichen Containerbytes.

## 3. Konfiguration ohne Geheimnisse einfrieren

1. Produktivschema und Deployment-Dateien des ausgewählten Commits verwenden.
2. Eine Positivliste aller prüfungsrelevanten Konfigurationsschlüssel mit
   gesetztem/nicht gesetztem Zustand und, soweit unkritisch, dem Wert erfassen.
3. Secrets ausschließlich durch Kennung, Quelle, Versions-ID und
   Rotationsstand referenzieren; Secret-Werte vollständig schwärzen.
4. Den bereinigten Snapshot hashen und unverändert zum Prüfungsdossier legen.
5. Abweichungen von der dokumentierten Standardkonfiguration begründen.

| Konfigurationsnachweis                           | Wert |
| ------------------------------------------------ | ---- |
| Bereinigter Snapshot (Dateiname)                 | `…`  |
| SHA-256 des Snapshots                            | `…`  |
| Secret-Quelle und Versionskennungen, keine Werte | `…`  |
| Bewusste Abweichungen                            | `…`  |
| Vier-Augen-Kontrolle am (UTC), durch             | `…`  |

## 4. Reproduzierbaren Datenbestand herstellen

Für die Prüfumgebung werden ausschließlich freigegebene synthetische Daten
oder rechtmäßig anonymisierte Prüfdaten eingesetzt. Ein vorhandener Demo-Seed
ist nicht automatisch vollständig für den vereinbarten Scope.

- Seed-Skript, Commit und SHA-256 dokumentieren.
- Startzustand der Datenbank durch Schema-/Migrationsstand und einen
  reproduzierbaren Dump oder eine nachvollziehbare Seed-Prozedur binden.
- Prüffälle mit ihren erwarteten Ergebnissen und den betroffenen
  Fachkatalog-Regel-IDs verknüpfen, soweit eine Regel betroffen ist.
- Positiv-, Negativ-, Berechtigungs-, Grenz- und Wiederholungsfälle abdecken.
- Konten, Rollen und Mandantenzuordnungen ohne reale Zugangsdaten dokumentieren.
- Zeitabhängige Fälle mit kontrollierter Zeitbasis oder eindeutigem Stichtag
  ausführen; die Systemuhr nicht undokumentiert verstellen.

| Datenbestandsnachweis                      | Wert |
| ------------------------------------------ | ---- |
| Seed-/Dump-Bezeichnung                     | `…`  |
| Quell-Commit und SHA-256                   | `…`  |
| Migrationsstand                            | `…`  |
| Synthetisch/anonymisiert und geprüft durch | `…`  |
| Fallkatalog / Traceability-Matrix          | `…`  |
| Bekannte nicht abgedeckte Fälle            | `…`  |

## 5. Technische Abnahme vor dem Einfrieren

Die Umgebung wird erst als „eingefroren“ bezeichnet, wenn die Prüfungen
dokumentiert erfolgreich waren oder Abweichungen ausdrücklich erfasst sind.

- [ ] Tag, Commit, Manifest und Image-Digests stimmen überein.
- [ ] Migrationen sind vollständig; Schema- und RLS-Drift-Prüfungen sind
      nachvollziehbar dokumentiert.
- [ ] Readiness- und Health-Prüfungen sind grün.
- [ ] Rollen, Mandantentrennung und beide Auth-Surfaces wurden geprüft.
- [ ] Schreibschutz/Object-Lock und Audit-Chain wurden im vereinbarten Scope
      geprüft.
- [ ] Backup und Restore wurden mit dieser oder einer nachweislich identischen
      Release-Konfiguration erprobt; Gleichwertigkeit ist begründet.
- [ ] Externe Abhängigkeiten, Versionen, Trust-Anker und Ausfallverhalten sind
      erfasst.
- [ ] Die zugehörige Release-Evidence ist vollständig und ihre Hashliste wurde
      gegengeprüft.

Ein grüner CI-Lauf allein belegt weder den Zustand der bereitgestellten
Prüfumgebung noch die Vollständigkeit des vereinbarten Prüfungsgegenstands.

## 6. Freeze und Änderungskontrolle

Nach der technischen Abnahme werden Änderungen kontrolliert:

1. Schreibzugriffe auf Deployment-Artefakte und Konfigurationssnapshot auf die
   benannten Verantwortlichen begrenzen.
2. VM-/Volume-Snapshot oder gleichwertigen reproduzierbaren Ausgangszustand
   erzeugen; Speicherort, Hash/ID und Zugriffsschutz dokumentieren.
3. Beginn des Freeze in UTC und die freigebenden Personen erfassen.
4. Jede Änderung mit Zeit, Anlass, ausführender Person, betroffenen Artefakten,
   Vorher-/Nachher-Hash und Auswirkung auf Prüffälle protokollieren.
5. Bei Änderung eines inhaltlich relevanten Artefakts eine neue Umgebungs-ID
   vergeben oder den Prüfer vor Fortsetzung über die Änderung entscheiden
   lassen. Ergebnisse verschiedener Zustände nicht still zusammenführen.

| Freeze-Nachweis                    | Wert                         |
| ---------------------------------- | ---------------------------- |
| Freeze-Beginn (UTC)                | `…`                          |
| Snapshot-/Baseline-ID              | `…`                          |
| Hashmanifest der Baseline          | `…`                          |
| Schreibberechtigte Rollen/Personen | `…`                          |
| Änderungsprotokoll                 | `…`                          |
| Technische Gegenprüfung            | Name / Datum / Ergebnis: `…` |
| Fachliche Scope-Bestätigung        | Name / Datum / Ergebnis: `…` |

## 7. Testdurchführung und Nachweissicherung

Jeder Testlauf wird mindestens mit Umgebungs-ID, Zeitpunkt in UTC,
Testfallversion, ausführender Person oder CI-Identität, Eingaben, Ergebnis und
Artefakt-Hashes erfasst. Fehlgeschlagene und wiederholte Läufe bleiben
erkennbar; nur den letzten grünen Lauf aufzubewahren würde den Verlauf
verfälschen.

Screenshots ergänzen maschinenlesbare Logs, ersetzen sie aber nicht. Logs
werden vor Aufnahme in das Dossier auf Secrets und personenbezogene Daten
geprüft. Die vollständige Artefaktliste erhält ein eigenes SHA-256-Manifest.

## 8. Abschluss und Aufbewahrung

Am Ende werden Prüfumgebung, Release-Evidence, Testprotokolle,
Abweichungsentscheidungen und Hashmanifest als zusammengehöriges Dossier
archiviert. Festzulegen sind Speicherort, Zugriffsrollen, Verschlüsselung,
Unveränderlichkeit, Aufbewahrungsende, Löschfreigabe und ein getesteter
Wiederherstellungsweg. Die Standard-Aufbewahrung eines CI-Systems darf nicht
ungeprüft als dauerhafte Archivierung vorausgesetzt werden.

Die Stilllegung der Prüfumgebung erfolgt erst nach dokumentierter Entscheidung,
dass die erforderlichen reproduzierbaren Artefakte und Nachweise gesichert
sind. Eine Aufbewahrung dieses Dossiers sagt nichts darüber aus, ob ein Prüfer
die Software als ordnungsgemäß beurteilt hat.

## Weiterführende Dokumente

- [Release-Evidence-Vorlage](./ps880-release-evidence.md)
- [Assurance Model](./assurance-model.md)
- [Known Limits](./known-limits.md)
- [Testkonzept](../development/testkonzept.md)
- [Entwicklungs- und Freigabeverfahren](../development/entwicklungsverfahren.md)
- [Release-Prozess](../operations/release.md)
