# TaxTronik — Dokumentierte Grenzen (Known Limits)

> Vertrauen wird nicht behauptet, sondern nachgewiesen. Teil des Nachweises ist
> die ehrliche Dokumentation dessen, was TaxTronik **nicht** leistet.

## 1. TaxTronik ersetzt keine fachliche Würdigung

Die Software automatisiert Workflows, Dokumentation, Fristen und Kommunikation.
Die **fachliche Beurteilung** steuerlicher Sachverhalte bleibt Aufgabe des
Beraters. TaxTronik strukturiert und konserviert, entscheidet aber nicht.

## 2. TaxTronik ist kein TCMS an sich

Ein Tax Compliance Management System (TCMS) umfasst Organisationsstrukturen,
Prozesse und Dokumentation über die Software hinaus. TaxTronik kann ein TCMS
**unterstützen**, aber nicht ersetzen. Die Verantwortung für ein funktionierendes
TCMS liegt bei der Kanzlei.

## 3. TaxTronik ersetzt keine IDW-Prüfung

Die IDW PS 880 / PS 980 Prüfungen erfordern unabhängige Prüfer und können nicht
durch Software allein erfüllt werden. TaxTronik ist auf Prüfungsreadiness
ausgelegt, ersetzt aber nicht die Prüfung selbst.

## 4. Quantum Randomness

Der Quantenlos-Vertrag liegt in `packages/risk-layer`, die tenantgebundene
Geschäftslogik in `apps/web/src/server/risk/los.ts`. Die Komponente
beschleunigt nichts und beweist nicht die Vollständigkeit der Population. Sie
bindet den vor der Ziehung festgelegten Rahmen an ein Commitment und speichert
Nachweis, Rahmen und gezogene IDs in der Audit-Chain. Je nach Backend (`qpu`,
`simulator`, `csprng`) gelten unterschiedliche Vertrauensannahmen. Die
Vollständigkeit der Erfassungsgrundlage ist eine fachliche Eingabe, kein
Software-Ergebnis.

## 5. Replay beweist nur Reproduzierbarkeit

Die Nachweisprüfung sendet den **gespeicherten Nachweis zusammen mit dem damals
gebundenen Rahmen** an `/v1/los/pruefen`. Sie überprüft Commitment,
Rahmenbindung und Auswahlbeleg; sie führt keine neue Ziehung aus und verspricht
nicht „gleiche Inputs → gleiche Auswahl". Der Nachweis belegt **nicht**, dass
der Rahmen vollständig oder die Stichprobenparameter fachlich beziehungsweise
rechtlich angemessen sind. Diese Prüfung bleibt obligatorisch.

## 6. Externe KI ist Hilfsmittel, nicht Entscheidungsinstanz

TaxTronik kann externe KI-Dienste (z. B. für Risiko-Analyse, Dokumenten-
Klassifizierung) einbinden. Diese Dienste liefern Vorschläge und Einschätzungen,
treffen aber keine bindenden Entscheidungen. Die Verantwortung liegt immer beim
menschlichen Berater. KI-Ergebnisse sind als Arbeitserleichterung zu verstehen,
nicht als fachliches Urteil.

## 7. RLS ist die letzte Barriere, nicht die einzige

Row-Level Security verhindert Cross-Tenant-Zugriff auf Datenbankebene. Sie ist
aber kein Ersatz für App-Level-Filter — beide Schichten müssen konsistent sein.
Wenn die App versehentlich alle Datensätze lädt (ohne Tenant-Filter) und nur RLS
filtert, ist das ein Performance- und Design-Problem, auch wenn keine Daten
leaken.

## 8. Audit-Chain schützt vor nachträglicher Änderung, nicht vor Echtzeit-Manipulation

Die lokale Hash-Chain verhindert keine Manipulation durch einen Angreifer, der
gleichzeitig Anwendung, Datenbank und Hostuhr kontrolliert. Der Worker bindet
den neuesten committeten Kettenpräfix zwar im Regelfall alle zwei Sekunden an
einen externen RFC-3161-Anker; zwischen lokalem Commit und erfolgreicher
TSA-Antwort bleibt jedoch ein sichtbares, nicht vollständig eliminierbares
Fenster. Bei TSA-/Netzausfall wächst der im Admin-Status überwachte Rückstand.
Der zusätzliche tägliche Seal ersetzt diese rollende Verankerung nicht.

## 9. Open Source bedeutet nicht automatisch sicher

Der Code ist offen einsehbar. Das ermöglicht unabhängige Prüfungen, bedeutet
aber auch, dass Angreifer die Sicherheitsarchitektur studieren können.
Security-by-Obscurity ist keine Schutzmaßnahme — aber Open Source ist kein
Schutz allein. Die Sicherheit resultiert aus den dokumentierten Schichten
(RLS, RBAC, Audit, Tests), nicht aus der Geheimhaltung des Codes.

## 10. Backups schützen nur, wenn sie getestet wurden

Ein ungetestetes Backup ist kein Backup. Der monatliche `backup-drill`
Worker-Job lädt den letzten erfolgreichen **Datenbank-Dump**, prüft dessen
SHA-256-Wert, spielt ihn in eine Wegwerf-Datenbank ein und verifiziert dort die
Audit-Hash-Chain. Das ist ein wichtiger DB-Nachweis, aber kein isolierter
Wiederanlauf des Gesamtsystems.

Der automatische Drill entschlüsselt kein versiegeltes `backup-full`, stellt
keine Cold-Snapshots von SeaweedFS, Redis oder n8n wieder her und prüft weder
n8n-Credentials noch Dokumentabruf, Login, Release-Images oder die
Recovery-Konfiguration. Auch `backup-verify` und `backup-decrypt` belegen nur
Signatur, Hashes, Entschlüsselbarkeit und Archivstruktur. Ein regelmäßig
dokumentierter **Full-Restore-Drill auf einem isolierten Zielsystem** bleibt
deshalb Betreiberpflicht. Gleiches gilt für getrennte Offsite-Kopien, die
Verfügbarkeit der offline verwahrten age-Identity und Public Keys sowie einen
getesteten Disaster-Recovery-Plan.

## 11. Release-Promotion ist fail-closed, die Publikation nicht transaktional

Der Release-Workflow erzwingt die vollständigen CI- und Security-Workflows im
selben Lauf für den exakten annotierten Tag-Commit. Das signierte Manifest
bindet Commit-SHA sowie Web- und Worker-Image an getrennte SHA-256-Digests. Die
Operator-CLI prüft Checkout und OCI-Labels, deployt beide Images digest-gepinnt
und bewahrt für Rollbacks einen vollständigen Last-Good-Vertrag auf. Die früher
dokumentierten CI- und Single-Image-Lücken sind damit keine offenen
Release-Blocker mehr.

Die Veröffentlichung über Container-Registry und separates Manifest-Repository
ist jedoch nicht atomar. Wenn ein Image bereits gepusht wurde und ein späterer
Push oder die Manifest-Publikation fehlschlägt, können partielle SemVer-Artefakte
in der Registry verbleiben. Ohne erfolgreich publiziertes Manifest werden sie
vom verifizierten Betreiberpfad nicht promotet oder deployt. Da Release-Tags
write-once sind, muss das Release-Team solche Reste vor einem Wiederholungslauf
prüfen und gegebenenfalls manuell bereinigen; automatische Registry-Bereinigung
und standortübergreifende Transaktionsgarantien bestehen nicht.

## 12. DATEV-Beleg-ZIP ist kein vollständiger GoBD-Datenzugriff

Ein aus TaxTronik erzeugtes DATEV-Beleg-ZIP dient dem strukturierten
Belegexport. Es weist für sich allein weder einen vollständigen Datenzugriff
nach den Formen Z1, Z2 und Z3 noch die Vollständigkeit aller steuerlich
relevanten Vorsystemdaten nach. Auswahl, Bereitstellung und Verfahrensnachweis
bleiben eine organisatorische Aufgabe der Kanzlei und ihrer angebundenen
Systeme.

## 13. Dokument-Uploads sind größenbegrenzt, aber noch nicht vollständig gestreamt

Die dokumentierten Upload-Routen parsen Multipart-Daten derzeit im
Web-Prozess. Eine einzelne Datei ist deshalb auf 25 MiB begrenzt; der
Anwendungscode bricht den eingehenden Request-Stream bei rund 26 MiB ab. Das
mitgelieferte nginx-Beispiel begrenzt zusätzlich Requestgröße und parallele
Uploads; beim optionalen Traefik-Deployment greift ein Buffering-Limit. Diese
Schranken reduzieren den Speicher- und DoS-Radius, machen den Parser aber nicht
zu einem O(1)-Streaming-Pfad.

Ein eigener oder umgangener Reverse Proxy muss mindestens gleichwertige Body-
und Parallelitätsgrenzen setzen. Für größere Dateien oder höhere parallele Last
ist vor einer Kapazitätsfreigabe ein Streaming-Multipart-Parser beziehungsweise
ein isolierter Import-Job erforderlich.

## 14. SMTP-Übergabe und Versandstatus sind keine gemeinsame Transaktion

E-Mail-Schritte speichern den erfolgreichen Status je Empfänger erst nach der
Annahme durch den konfigurierten SMTP-Server. Ein Retry überspringt bereits als
versandt gespeicherte Empfänger. Stürzt der Prozess jedoch nach der
SMTP-Annahme und vor der Statusspeicherung ab, ist eine Doppelzustellung beim
Retry möglich. SMTP-Annahme belegt außerdem keine endgültige Zustellung an das
Empfängerpostfach.

## 15. Fail-closed Session-Widerruf hat eine Redis-Verfügbarkeitsabhängigkeit

Schreiben und Lesen des benutzerbezogenen Session-Widerrufszeitpunkts sind
fail-closed. Bei Redis-Ausfall werden betroffene Sessionprüfungen abgelehnt und
sicherheitskritische Widerrufsaktionen nicht als erfolgreich gemeldet. Das
verhindert die Nutzung eines Tokens ohne belastbare Widerrufsprüfung, kann aber
Authentifizierung und bestehende Sitzungen bis zur Redis-Wiederherstellung
vorübergehend blockieren.
