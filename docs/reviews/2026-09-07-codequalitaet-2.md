# Zweite lokale Qualitätsprüfung vom 7. September 2026

Ausgangsstand: `487f13030b53c629c91c25355a1988565e3b95a1` auf `main`.
Diese Runde ergänzt die vorherige Prüfung um Benachrichtigungen,
Dokumentenauswahl, XLSX-Verarbeitung und die GwG-Seite. Alle Laufzeitproben
verwenden lokale synthetische Daten.

## Benachrichtigungen: ungelesene Hinweise und Gesamtzähler

Die bisherige aufsteigende Sortierung nach `readAt` stellte in PostgreSQL
NULL-Werte ans Ende. Mehr als 100 gelesene Hinweise konnten dadurch alle
ungelesenen aus der begrenzten Liste verdrängen. Der aus dieser Liste
berechnete Zähler meldete dann fälschlich „Alles gelesen“. Bei mehr als
100 ungelesenen Hinweisen wurde die Gesamtzahl außerdem abgeschnitten.

Die Abfrage setzt ausdrücklich `NULLS FIRST`, ordnet Zeitgleichstände nach ID
und zählt alle berechtigten ungelesenen Hinweise unabhängig vom Anzeigefenster.
Liste und Count verwenden denselben persönlichen beziehungsweise kanzleiweiten
Empfängerfilter, eine explizite Tenantbedingung und dieselbe Tenant-Transaktion.
Die Oberfläche nennt bei 100 sichtbaren Einträgen die Fenstergröße.
Markierungsaktionen und Zugriffskonzept bleiben erhalten.

Sieben neue Tests rendern die echte Seite. Das Datenbankdouble sortiert vor
der Begrenzung einschließlich PostgreSQL-NULL-Semantik; es liefert keine
vorab passend zugeschnittene Ergebnisliste. Die Tests erfassen außerdem
Empfängerbindung, Gleichstände, leeren Bestand und den vorgelagerten
Berechtigungsabbruch. Zusammen mit den bisherigen Action-Tests bestehen
neun Fälle. Regel: `ACCESS-NOTIFICATION-RECIPIENT-001`, technische Ausnahme
`FK-EXC-20260907-003`.

## Dokumentenbrowser: Auswahl über Kontextwechsel hinweg

Die Zeilenaktion „Verschieben“ schaltete eine bereits allein ausgewählte Datei
wieder ab. Der Dialog erhielt damit keine zu verschiebende Datei. Die Aktion
setzt nun ausdrücklich eine Einzelauswahl.

Außerdem überlebten Auswahl, lokale Filter und offene Dialoge einen Wechsel
des Mandanten, Ordners oder der URL-Suche. Eine gemeinsame React-Kontextgrenze
um Ansichten und Dialoge setzt diesen Zustand bei einem Bereichswechsel
zurück. Eine Aktualisierung derselben Ansicht bewahrt Auswahl und Suchentwurf.
Die bestehende übergeordnete Tenant-/Benutzergrenze bleibt erhalten.

Vier neue Browser-Reproduktionen waren vorher rot. Die dauerhafte Playwright-
Datei `19-document-explorer-state.spec.ts` besteht mit sieben Fällen: Verschieben
mit und ohne Vorauswahl, Browser-Ordner/URL-Suche, Mandantenwechsel mit offenem
Dialog, Embedded-Mandantenwechsel sowie Erhaltung bei Aktualisierungen beider
Varianten. Es laufen die echten React-Komponenten in Chromium; Server-Actions,
Router und Upload-/Vorschauboundaries sind synthetisch. Externe Netzwerkzugriffe
sind abgefangen. Fünf bestehende Hilfsfunktionstests bestehen ebenfalls.
Die Tests verwenden vorhandene Dependencies; das Lockfile bleibt unverändert.
Der Spec ist in der expliziten Paranoid-E2E-Liste des Forgejo-Workflows
eingebunden; der Vollständigkeitsguard besteht.

## XLSX: Blattzuordnung, Parserlaufzeit und Texttreue

Der ZIP-Filter entpackte nur XML-Dateien und überging
`xl/_rels/workbook.xml.rels`. Obwohl der Reader Relationship-Ziele auswertete,
erreichten ihn diese Daten nie. Vertauschte interne Blattnummern lieferten
Werte unter dem falschen Blattnamen; individuelle Blattdateinamen führten zu
leeren Ergebnissen. Der Filter lässt die benötigte Relationship-Datei nun
unter denselben Größenbudgets zu. Vier echte ZIP-Reproduktionen waren vorher
rot. Auch die Ablehnung einer überhöhten deklarierten Entpackgröße wird geprüft.

Die suchende XML-Attributregex prüfte bei einem langen fehlerhaften Namen
wiederholt dessen Suffixe. Ein 300-KiB-Fall überschritt vor der Korrektur das
Prozess-Zeitlimit von fünf Sekunden. Der fortlaufende Scanner benötigte für
diesen Fall lokal ungefähr acht Millisekunden reine Parserzeit. Eine dauerhafte
Regression läuft in einem separaten Prozess, damit der Timeout auch bei einem
blockierenden synchronen Parser wirksam bleibt. Dies ist ein Nachweis für den
konkreten Fall, keine allgemeine Laufzeitgarantie für beliebiges XML.

Die unabhängige Gegenprüfung fand zudem, dass unbekannte Entities wie
`&constructor;` über geerbte Objektfelder in Funktionstext umgewandelt wurden.
Die Entity-Auflösung berücksichtigt jetzt ausschließlich eigene Einträge der
fünf unterstützten XML-Entities. Vier Regressionen bestätigen die Texttreue.
Insgesamt bestehen 44 gezielte Fälle einschließlich DATEV-Parser und
Zellformatierung. Die XML-Unterstützung bleibt bewusst begrenzt; es wird keine
vollständige OOXML-Validierung zugesagt.

`BWA-IMPORT-MAPPING-001` enthält die ergänzten Umsetzungshinweise und
Nachweise. Die dort bereits dokumentierten fachlichen Grenzen bleiben offen:
DATEV 1051 wird intern als `revenue` geführt, und 1300 dient als Fallback für
`resultBeforeTax`. Diese Bedeutungsabweichungen werden durch die technische
Lesekorrektur nicht aufgelöst. Perioden- und Kennzahlmapping wurden nicht
verändert; eine fachliche Freigabe wurde nicht erteilt.

## GwG: aktuelle Verwendbarkeit und verständlichere Struktur

Ein gespeicherter `VERIFIED`-Status zeigte trotz bereits erreichter
Gültigkeitsgrenze oder gesetztem `destroyedAt` weiterhin eine grüne aktuelle
Verifikation samt Weiter-Schaltfläche im Onboarding. Vernichtete Entwurfs- und
Prüfaufzeichnungen boten außerdem noch Personenbereiche und teilweise eine
Freigabemaske an.

Die Anzeige berücksichtigt Gültigkeit und Vernichtung nun gesondert von der
gespeicherten historischen Entscheidung. Abgelaufene Prüfungen zeigen keine
aktuelle Freigabe. Vernichtete Aufzeichnungen rekonstruieren keine
Personenansicht aus aktuellen Mandantenstammdaten und zeigen weder Bearbeitung
noch Freigabe. Die vorhandene Wiederholungsaktion bleibt für die bisherigen
terminalen Statuswerte verfügbar; nichtterminale Vernichtungsreste erhalten
keinen erfundenen Wiederherstellungsablauf.

Die bisher 1476 Zeilen lange Seite umfasst jetzt 130 Zeilen und ist in Datenzugriff, Anzeigeaufbereitung,
Status, Personen, Nachweise, Einladung und Risikobewertung aufgeteilt.
Unbenutzte zusätzliche Uploadabfragen und Projektionen entfallen.
Der unabhängige Vergleich prüft insbesondere Rollen, Formularaktionen,
Nachweisfilter, historische Nachweise, CAS-Revisionen und die Bindung der
Berufsträgerentscheidung an den unveränderten Snapshot.

Regeln: `GWG-REVERIFICATION-VALIDITY-001`, `GWG-RETENTION-DESTRUCTION-001`
und die in den Umsetzungshinweisen referenzierten Identifizierungs-,
Vertretungs-, Eigentümer-, Risiko- und Onboarding-Regeln. Der Prüfbericht
belegt technische Korrekturen, keine Berufsträgerfreigabe.

Der gezielte GwG-Lauf besteht mit 234 Fällen in 27 Dateien, darunter
24 neue Render-/Projektionsfälle. Elf bisherige Prüfungen auf bestimmte
Quelltextfragmente der Seite entfallen zugunsten der Verhaltensnachweise.
Fünf anfängliche Fehlerfälle waren vor der Korrektur rot; der gültige
VERIFIED-Kontrollfall war bereits grün.

## Gemeinsame Nachweise

- Vollständige Unit-Suite ohne Cache: **3913 bestanden**, neun bewusst
  ausgelassene DB-/Redis-Opt-ins, kein Fehler. 13 Testpakete und 21 erfolgreiche
  Turbo-Tasks. Netto 32 zusätzliche Fälle; gezielte Teilprüfungen sind darin
  enthalten und werden nicht nochmals addiert.
- Vollständiger Typecheck: 22 erfolgreiche Tasks ohne Cache. ESLint: keine
  Fehler, 70 verbleibende Komplexitätswarnungen. React-Compiler-Baseline: null
  Warnungen. `GwgPage` mit bisher 75 und `parseXml` mit bisher 22 entfallen aus
  der Komplexitätsbaseline. Der Spitzenwert sinkt von 75 auf 58, der Grenzwert
  bleibt 20. Es wurden keine Warnungen unterdrückt oder Grenzwerte gelockert.
- SHA-256-Abgleich der 24 geänderten Quell-/Test-/Baseline-Dateien: unverändert
  während Gesamtprüfung und Produktionsbuild.
- Formatierung, Dokumentationslinks und deren Tests, 33 Fachkatalogtests,
  `pnpm fachkatalog:check` und `pnpm fachkatalog:diff` bestanden. 80 Regeln sind
  gültig indiziert, 17 Fachpfadänderungen konkret zugeordnet. Alle
  `professional_review`-Felder sind automatisch gegen den Ausgangsstand
  verglichen und unverändert.
- Migrations-Zeilenendenguard sowie vier Migrationsrunner- und 18 Ledger-
  Hilfstests bestanden. Es gibt keine Schema-, Migrations- oder
  Dependencyänderung. Guards gegen fokussierte/ausgelassene Tests und für
  vollständige CI-E2E-Verdrahtung bestehen.
- Produktionsbuild mit 6 GiB Speicherlimit und ohne Swap erfolgreich.
  Image: `taxtronik/web:local-quality2-20260907`,
  `sha256:5ec05e25394b353d7c79c1885f20dd2674a1d2970dead3a344e8ebee04711f96`.
  Dasselbe Image ist im lokalen Webcontainer geprüft. HTTPS-Health und
  Loginseite liefern 200; beide TOTP-Bypassvariablen stehen auf `false`.
- Scan dieses Images mit dem in CI gepinnten Trivy 0.71.0: null bekannte
  Schwachstellen über alle Schweregrade und null Secrets, auch ohne
  `ignore-unfixed`. Critical-Gate bestanden; CycloneDX-SBOM mit 145 Komponenten.
  Die Vulnerability-Datenbank ist vom 6. September 2026, 13:03 UTC, mit
  nächstem Update am 7. September, 13:03 UTC. Der Scanner meldet eine neuere
  eigene Version; Alpine 3.24 wird auf Schwachstellen geprüft, ist aber noch
  nicht in seiner EOL-Liste enthalten.

- Drei zusätzliche Chromium-Fälle am Produktionsimage bestanden nach echter
  Passwort-/TOTP-Einrichtung und Anmeldung. 110 gelesene und zwei ältere
  ungelesene Hinweise ergeben zwei offene Hinweise am Listenanfang. Bei
  anschließend 125 ungelesenen Hinweisen bleibt der Gesamtzähler 125, während
  genau 100 Einträge erscheinen. Die vollständige sichtbare Reihenfolge stimmt
  mit PostgreSQL unter `taxtronik_app` und Tenantkontext überein.
- Der dritte Produktionsfall öffnet eine vorhandene synthetische GwG-Prüfung
  rein lesend. Die Seite rendert ohne Clientfehler; Datenbank-Fingerprints von
  Mandant, Prüfungen, Personen, Nachweisen und Einladungen bleiben unverändert.
  Zusammen mit den sieben isolierten Explorerfällen sind zehn Browserfälle
  dieser Runde grün. Abgelaufene und vernichtete GwG-Konstellationen sind durch
  die SSR-Regressionen geprüft, nicht durch neue Produktionsfixtures.
- Alle 235 eigenen Testbenachrichtigungen sind gelöscht. Das eigene Testkonto
  ist deaktiviert, sein Passwort ersetzt, die Auth-Revision erhöht und sämtliche
  TOTP-/Recoverydaten gelöscht. Die zwei tatsächlichen Auth-Auditereignisse
  bleiben erhalten. Eine unabhängige SQL-Gegenprüfung bestätigt null verbleibende
  eigene Benachrichtigungen und die Kontobereinigung. Alle sieben Container mit
  dem Präfix `kk-full-e2e-` sind ausdrücklich gestoppt; fremde Dienste bleiben
  unberührt.

Der vollständige Datenbank- und umfassende E2E-Lauf aus dem ursprünglichen
Volltest wird in dieser Runde nicht erneut behauptet. Neu ausgeführt werden
die Gesamtsuite der Unit-Tests und gezielte Browser-/PostgreSQL-Nachweise für
die betroffenen Ansichten. Es gibt keinen VPS- oder Live-Prod-Test. Die
verbleibenden Komplexitätswarnungen und die dokumentierten fachlichen Grenzen
des BWA-Mappings sind weiterhin offene Verbesserungsmöglichkeiten.
