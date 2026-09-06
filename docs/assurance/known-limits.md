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

Beim n8n-Rechercheversand werden Text, Rechtsfrage, Auftrag, Normanker und
Governance-Typ technisch reduziert und über einen gemeinsamen Platzhalternamensraum
zurückgeordnet. Die
editierbare Vorschau ist serverseitig nicht per Token oder Hash an den Versand
gebunden. Änderungen am Quelltext oder an Stammdaten zwischen Vorschau und
Versand erfordern deshalb eine erneute manuelle Vorschau. Unbekannte oder nur
kontextuell erkennbare Geheimnisse können die Filter weiterhin passieren.
Diese Funktion ist weder ein Anonymitätsnachweis noch
eine Freigabe nach § 203 StGB oder Datenschutzrecht.

Der initiale Risk-Analysepfad referenziert einen vollständigen Engine-Rohoutput.
Die spätere asynchrone LLM-Anreicherung speichert dagegen nur neue
Markierungen, Status und begrenzte Audit-Metadaten, nicht ihren vollständigen
Rohoutput und dessen Katalogversion.

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
Aktionen mit ausdrücklich benötigtem Redis-Widerruf nicht als erfolgreich
gemeldet. Das verhindert die Nutzung eines Tokens ohne belastbare
Widerrufsprüfung, kann aber Authentifizierung und bestehende Sitzungen bis zur
Redis-Wiederherstellung vorübergehend blockieren. Staff-Passwortänderungen,
Passwort-/TOTP-Sicherheitsresets sowie Hardware-Moduswechsel und -Recovery
verwenden zusätzlich beziehungsweise statt eines neuen Redis-Zeitstempels die
transaktional erhöhte `authRevision`; ihr bereits eingelöster Session-Guard
bleibt dennoch von der fail-closed Redis-Leseprüfung abhängig.

## 16. Hardware-Attestation identifiziert keine individuelle Geräteinstanz

Der optionale Staff-Modus akzeptiert erst nach persönlichem Opt-in und zwei
registrierten Credentials ausschließlich physische FIDO2-Sicherheitsschlüssel;
Passwort, TOTP und Backup-Codes sind dann keine Anmelde-Fallbacks. TaxTronik
erzwingt User Verification, `cross-platform`, `singleDevice`, einen nicht
gesicherten Credential-Status und gemeldete Hardware-Transporte. Integrierte,
hybride und Multi-Device-Credentials werden abgewiesen.

Enrollment ist nur mit nichtleerer Deployment-AAGUID-Allowlist möglich,
fordert `attestation: direct` und akzeptiert eine vollständige `packed`-
Attestation mit Zertifikatskette. Die Zertifikat-AAGUID muss vorhanden,
nichtkritisch und identisch mit den signierten Authenticator-Daten sein;
Größen- und 30-Sekunden-Grenzen beschränken die Registration-Verifikation.
TaxTronik initialisiert FIDO MDS `strict` und
fordert ein aktuelles Metadata Statement mit vertrauenswürdiger Root,
`basic_full`, Hardware- oder Secure-Element-Schlüsselschutz und externer
Authentikator-Klassifizierung. Der selbst verifizierte signierte Gesamt-BLOB
muss außerdem einen aktuell wirksamen `FIDO_CERTIFIED*`-Status enthalten;
außer `UPDATE_AVAILABLE` werden alle anderen, unbekannten oder fehlenden
Statuswerte abgewiesen. Die aktuelle Allowlist, der vollständige MDS-Eintrag
und das Statement werden vor jeder späteren Hardware-Assertion erneut geprüft.
Zusätzlich bindet die Anwendung den geschützten MDS-Header eng an die erwartete
Signer-/Intermediate-Identität. Die bei Registrierung aus dem
Attestationszertifikat gelesene Firmware-Version muss die aktuellen
MDS-Mindestwerte erfüllen und wird unveränderlich gespeichert.

Dieser Nachweis ordnet das Credential einer freigegebenen Modellfamilie zu.
Die AAGUID ist keine Seriennummer und identifiziert kein einzelnes physisches
Gerät. Auch mehrere Credential-IDs mit derselben oder verschiedenen AAGUIDs
beweisen nicht kryptografisch, dass sie von unterschiedlichen physischen
Instanzen stammen. `authenticatorAttachment` und `response.transports` bleiben
nicht attestierte Clientangaben und damit nur zusätzliche Produktfilter.

Bei der Modusaktivierung wird die frische Assertion eines einzigen
registrierten Schlüssels geprüft. Der zweite Schlüssel muss aktiv sein und die
aktuelle Allowlist-/MDS-/Provenienzprüfung ebenfalls bestehen, wird bei dieser
Aktivierung aber nicht erneut angefordert. Die Kanzlei muss
deshalb die getrennte Funktionsprüfung beider Schlüssel organisatorisch
sicherstellen.

Die Richtlinie schafft zugleich eine externe Verfügbarkeitsabhängigkeit: Eine
leere Allowlist, MDS-/DNS-/TLS-/Egress-Ausfall, fehlende Metadaten oder ein
abgewiesener Modellstatus blockieren Enrollment und jede Hardware-Assertion
fail-closed. Der Produktionsstart bindet die konfigurierte Hardware-Policy nur
an die Datenbank und führt dabei keinen MDS-Netzzugriff aus; die externe
Abhängigkeit beginnt erst mit einer Hardware-Zeremonie. Das gilt auch bei
nicht erreichbaren CA-Sperrlisten: Sie werden
erst nach einem vertrauenswürdigen Kettenaufbau geladen, müssen frisch und vom
tatsächlichen Issuer signiert sein und folgen keiner Umleitung. Akzeptiert wird
nur genau eine unpartitionierte Voll-CRL-URI; mehrere Distribution Points oder
Namen, Reason-/Issuer-Scope, Zertifikat-seitige `freshestCRL`-Verweise sowie
Delta-/`issuingDistributionPoint`-/`freshestCRL`-Extensions und unbekannte
kritische Extensions in der CRL blockieren bewusst fail-closed. Der
MDS-Snapshot ist prozesslokal und wird spätestens stündlich oder zum früheren
`nextUpdate` bedarfsgetrieben aktualisiert. Seine signierte Seriennummer wird
nach kryptografischer BLOB-Prüfung und noch vor der lokalen Allowlist-/
Modellfilterung monoton übernommen. Ein gültiger neuer BLOB ohne lokal
nutzbares Modell kann die zentrale Serie daher fortschreiben, während der
Hardware-Vorgang fail-closed scheitert. Die Tabelle ohne App-Tabellenrechte
bindet zusätzlich `WEBAUTHN_HARDWARE_POLICY_REVISION` und den kanonischen Hash
aus Aktivstatus und sortierter Allowlist, nicht den BLOB selbst. Eine schmale
SECURITY-DEFINER-Funktion vergleicht und share-lockt das exakte Tripel aus
Serie, Policy-Revision und Policy-Hash bis zum WebAuthn-Commit; der MDS-Lock
wird vor Staff-Locks genommen. Damit kann ein inzwischen überholter
Prozess-Snapshot nicht mehr committen. Eine höhere Revision verdrängt alte
Replicas; dieselbe Revision mit anderem Hash oder eine niedrigere Revision
wird abgewiesen. Auch die globale Deaktivierung über eine leere Allowlist
erfordert daher eine höhere Revision. Eine fehlerhaft koordinierte Revision
kann Hardware-Zugänge während eines Rolling Deployments bewusst fail-closed
blockieren. Es gibt derzeit keinen eigenen periodischen Refresh-Job oder
persistenten Offline-Cache. BLOB- und CRL-Abrufe hinterlassen bei den externen
Diensten Server-Verbindungsdaten. Details zu Monitoring, Refresh,
Allowlist-Änderungen und Datenschutz stehen im
[FIDO-MDS-Runbook](../operations/fido-mds.md).

Ein neuer MDS-Modellstatus wird ohne Push-Kanal daher spätestens nach einer
Stunde übernommen; ein bereits authentisierter CRL-Cacheeintrag kann bis zum
signierten `nextUpdate` der CA gelten. Die verpflichtende Zertifikat-AAGUID und
die strikten CA-Constraints können ältere oder abweichend ausgestellte
Schlüssel trotz grundsätzlich vorhandener FIDO2-Funktionalität ausschließen.
Das ist vor Beschaffung und Freigabe mit der konkreten Modell-/Firmware-Serie
zu testen. Das 30-Sekunden-Limit schützt die Verfügbarkeit, kann aber bei
anhaltend langsamen MDS-/CRL-Verbindungen ebenfalls Enrollment verhindern.

Die bewusst nicht unterstützten partitionierten, indirekten und Delta-CRL-
Formen können Schlüsselmodelle trotz grundsätzlich gültiger Attestation
ausschließen. Vor einer AAGUID-Freigabe ist deshalb die konkrete
Zertifikats-/CRL-Struktur des Herstellers zu testen; Unterstützung darf erst
mit vollständiger Merge-, Scope- und Cache-Semantik erweitert werden.

Die gespeicherte Firmware-Version ist kein laufender Gerätekanal: Assertions
liefern kein neues Attestationszertifikat. Ein nachträgliches Upgrade oder
Downgrade wird daher nicht unmittelbar erkannt. Steigt die MDS-Mindestversion
über den gespeicherten Wert, wird das Credential vorsorglich gesperrt und muss
mit aktueller Attestation neu registriert werden. Ein legitimer Wechsel der
MDS-Signeridentität oder des fest gebundenen Intermediates blockiert ebenfalls
bis zu einem geprüften Software-Release; das ist ein bewusster
Verfügbarkeits-Trade-off der engen Vertrauensbindung.

Der zweite Schlüssel ist deshalb getrennt aufzubewahren. Nach Verlust aller
Schlüssel gibt es keinen Passwort-/OTP-Bypass: Eine berechtigte übergeordnete
Rolle muss den auditierten Break-glass-Reset ausführen; für ADMIN-Konten bleibt
die Owner-CLI erforderlich. Dabei werden Sitzungen ungültig, alle registrierten
Schlüssel gesperrt und Passwort plus TOTP neu eingerichtet. Der Web-Reset
verlangt einen Step-up des Akteurs: aktuelles Passwort plus frischen TOTP ohne
Backup-Code oder, bei eigenem Hardware-only-Modus, den eigenen Schlüssel mit
Actor-/Ziel-/Auth-Revision-Bindung. Credential-Widerruf, Moduswechsel,
`authRevision`-Erhöhung und Audit sind datenbanktransaktional; die neue
Revision ist der autoritative Cutoff für vorherige Staff-Sessions. Dadurch
bleibt bei einem unter den DB-Locks abgewiesenen Rollen- oder Zustandsrennen
kein vorgelagerter Redis-Logout zurück. Ein Hostname- oder Originwechsel kann
wegen der WebAuthn-RP-/Origin-Bindung ebenfalls Recovery-Aufwand auslösen und
muss vor der Umstellung getestet werden.

Der Recovery-Rollenboden ist absichtlich enger als die allgemeinen
Web-Administrationsrechte: Kein Staff-Akteur kann eine ADMIN-Rolle entziehen;
eine PARTNER-Rolle kann nur ein aktiver ADMIN desselben Tenants entziehen.
Normale administrative Passwort-/TOTP-Resets sind an die erwartete
Actor-`authRevision` gebunden und widerrufen auch im Passwortmodus ruhende,
noch aktive Hardware-Credentials des Zielkontos. Eine eigene Passwortänderung
widerruft entsprechend die eigenen aktiven Vorabregistrierungen. Solche
Credentials müssen danach neu registriert werden.

Die Owner-CLI schreibt das Klartextpasswort ausschließlich in die
Credential-Datei und niemals auf `stdout`, `stderr` oder in Logs. Sie legt die
Datei exklusiv (`O_EXCL`) und mit No-follow-Schutz an und synchronisiert auf
POSIX nach Modus `0600` erst die Datei, dann ihr Elternverzeichnis, bevor ihre
Datenbanktransaktion committen darf. Eine vorhandene Zieldatei oder ein
Ausgabefehler lässt den Reset zurückrollen; eine in diesem Versuch entstandene
Teildatei wird gezielt entfernt. Falls erst der anschließende Datenbank-Commit
fehlschlägt, kann eine sicher geschriebene, aber nicht wirksame Recovery-Datei
zurückbleiben; sie ist anhand des CLI-Ergebnisses zu verwerfen, bevor der
Operator den Vorgang mit einem neuen Zielpfad wiederholt.

Der Owner-CLI-Reset erscheint atomar in der Tenant-Hashkette, kann mangels
angemeldeter Anwendungssitzung aber nur den Akteurtyp `SYSTEM` ausweisen. Die
Hashkette belegt damit den ausgeführten Prozess, nicht die persönliche Identität
des Operators. Zugriff auf Host, Datenbank-Zugangsdaten und CLI-Ausführung muss
deshalb zusätzlich betrieblich beschränkt und nachvollzogen werden.
