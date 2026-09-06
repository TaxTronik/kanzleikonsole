# Lokaler EU-Sanktionsabgleich und dokumentierte PEP-Recherche

Fachregel: **GWG-SCREENING-001**, fachlich **unreviewed**, Modul
`sanctionsScreening` standardmäßig aus. Kein Aufruf eines externen Matchingdienstes.
Diese Umsetzung ergänzt Nachweise; sie ersetzt keine GwG-Prüfung und keine
Entscheidung zu Sanktionen, Eigentum, Kontrolle oder PEP-Eigenschaften.

## Bedienung

- `/staff/admin/screening`: Admin/Partner lädt die offizielle XML-Liste und sieht
  Veröffentlichung, erfolgreichen Abruf, Fehler, Versionskennung und SHA-256.
- `/staff/clients/[id]/screening`: zugriffsberechtigte Mitarbeiter erfassen Namen,
  Rolle und optional Geburtsdatum. Natürliche Personen, Gesellschaften, Vertreter
  und wirtschaftlich Berechtigte werden bewusst einzeln benannt; es erfolgt
  keine automatische rechtliche Zuordnung aus einer Gesellschaftsstruktur.
- Eine PEP-Recherche ist rein manuell: Person, Ergebnis, Rechercheumfang,
  Begründung, mindestens eine Quellen-URL, Zeitpunkt und Bearbeiter.
- Entscheidungen werden angehängt. Alte Prüfläufe und Entscheidungen bleiben
  unverändert. Ein falsch positives Ergebnis auf einem alten Stand unterdrückt
  keinen späteren Treffer. Die Oberfläche zeigt die letzten 50 Prüfläufe.

## Datenquelle und Sicherheit

Offizielle Quelle: [EU-Datenkatalog](https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en),
XML 1.1 vom dort veröffentlichten `webgate.ec.europa.eu`-Download.
Der im öffentlichen Download veröffentlichte Token ist keine Nutzerkennung.
Der Download benötigt kein kostenpflichtiges Datenabonnement. Daraus folgt
keine Behauptung, die Daten seien gemeinfrei; Quellen- und Nutzungshinweise der
Kommission bleiben maßgeblich. Geprüft am 31.08.2026.

Nur die fest programmierte HTTPS-Adresse wird abgerufen, keine Redirects,
30 Sekunden Gesamtlaufzeit, maximal 64 MiB inklusive Streaminglimit. DTD und
Entitätsdeklarationen werden abgewiesen. Erwarteter Namensraum, gültiges XML,
Quellkennung, Datum, eindeutige Einträge und mindestens ein Alias je Eintrag sind
Pflicht. Ein live geladener Bestand unter 100 Einträgen, ein rückwärts laufender
Publikationsstand oder ein Rückgang über 20 % wird nicht automatisch übernommen.
Diese Schwellen sind technische Schutzregeln, keine rechtlichen Kriterien.

SHA-256 identifiziert die heruntergeladenen Rohbytes. Persistiert werden
normalisierte Quelldaten mit Originalnamen, Aliasstärke, Datumsangaben,
Staatsangehörigkeiten und Verordnungsreferenzen; nicht die vollständige XML-Datei.
Ein Quellhash authentifiziert keine Entscheidung einer Person und ersetzt
keine unabhängige Archivierung der Rohquelle.

Letzter erfolgreicher Abruf und Veröffentlichungsdatum bleiben getrennt.
Ein unveränderter, heute erfolgreich geprüfter Bestand ist technisch aktuell.
Jeder Abruffehler oder mehr als 48 Stunden ohne erfolgreichen Abruf sperrt neue
manuelle EU-Prüfläufe. Bestehende Nachweise und letzter gültiger Bestand bleiben.

## Zusätzliche Sperre vor einer neuen GwG-Freigabe

Ein später dokumentierter ungeklärter oder bestätigter Sanktionshinweis sperrt
auch einen Prüflauf ohne maschinellen Namenskandidaten. Unvollständige oder
widersprüchliche gespeicherte Ergebnisstrukturen werden ebenfalls abgewiesen.

Bei aktiviertem Modul prüft `verifyCheckAction` vor dem VERIFIED-Claim die
vollständige aktuelle Abdeckung: Mandant/Gesellschaft, jeder hinterlegte Vertreter
und jeder wirtschaftlich Berechtigte benötigen einen EU-Nachweis; natürliche
Personen zusätzlich eine abgeschlossene manuelle PEP-Recherche. Die Bindung
enthält Check-ID, Hash des aktuellen Berufsträger-Prüfsnapshots plus aktuelle
Personendaten und stabile Ziel-ID. Freie Nachweise erfüllen diese Sperre nicht.

Zuerst wird die GwG-Fassung zur Prüfung eingereicht, anschließend werden im
Screening die Ziele der aktuellen Fassung ausgewählt. Die Namen und Datumsdaten
gebundener Nachweise stammen serverseitig aus dieser Fassung. Datenänderungen
oder ein neuer Quellenstand verlangen neue gebundene Nachweise. Ungeklärte oder
bestätigte Sanktionskandidaten sowie gekürzte Kandidatenlisten sperren die
Freigabe. PEP-Funde verlangen HIGH und eine PEP-Antwort in der Risikobewertung;
die notwendige Risikoänderung erzeugt eine erneut zu prüfende Fassung.

Die Sperre, gebundene Nachweise, Beurteilungen und Workerfolgeläufe verwenden
denselben Mandats-Lifecycle-Lock. Quelle und Modulkonfiguration werden für die
Entscheidung stabil gelesen. Diese Sperre liegt im Anwendungs-Freigabepfad;
sie ersetzt keine organisatorische Kontrolle und keine explizite Entscheidung
des zugeordneten Berufsträgers. Historische VERIFIED-Checks bleiben unverändert.

## Matching und Folgeprüfungen

Der versionierte Algorithmus `eu-alias-dice-v1` verwendet Unicode-Normalisierung,
Groß-/Kleinschreibung, Interpunktion und sortierte Namensbestandteile. Ab einer
Dice-Ähnlichkeit von 0,82 entstehen Kandidaten; kurze Namen werden nur exakt
gefunden. Beide Aliasstärken bleiben sichtbar. Geburtsdaten erhöhen die
Information, unterdrücken aber auch bei Widerspruch keinen Namenskandidaten.
Maximal 100 Kandidaten werden im Nachweis gezeigt; die Gesamtzahl und eine
etwaige Kürzung werden ausdrücklich angegeben.

Der Matcher ist kein vollständiges Transliteration-, Identitäts- oder
Eigentums-/Kontrollprüfsystem. `NO_NAME_CANDIDATE` bedeutet ausschließlich, dass
dieser Algorithmus im bezeichneten Bestand keinen Namenskandidaten fand.

`runSanctionsRefresh` wird täglich durch den Worker aufgerufen. Ohne aktiviertes
Modul erfolgt kein Download. Je ursprünglicher Prüfung und geändertem Snapshot
entsteht höchstens ein eigener Folgelauf (Unique-Key, Advisory-Lock), auch nach
Jobabbruch und Wiederholung. Die Verarbeitung erfolgt in Zehnerbatches.
Beendete/anonymisierte Mandate sind ausgeschlossen. Admin/Partner erhalten
mandantenbezogene interne Hinweise; Berechtigungen werden erneut gefiltert.
Ein Hinweis löst keine automatische GwG-Risikoänderung oder Freigabe aus.

## Speicherung und offene Betriebsgrenzen

Neue Tabellen: `sanctions_snapshot`, `sanctions_source_state`, `screening_run`,
`screening_review`. Tenant-RLS, zusammengesetzte Tenant-/Mandanten-Fremdschlüssel,
Mitarbeiterzugriff und Append-only-Trigger sichern den neuen Datenpfad.
Portalkontakte haben keinen Zugriff. Audit-Ereignisse enthalten IDs und
Ergebniszählwerte statt erneut die vollständigen Personendaten.

**Vor produktiver Aktivierung offen:** Berufsträgerprüfung des Verfahrens,
organisatorische Trefferbearbeitung und ein freigegebener Aufbewahrungs-/Löschpfad
für die zusätzlichen Personennachweise. Die bestehenden GwG-/DSGVO-Löschläufe
löschen diese neuen Tabellen noch nicht. Der Append-only-Schutz ist kein
gesetzliches Recht auf unbegrenzte Speicherung. Ein administrativer
Massenoverride für diese Schranken wurde bewusst nicht geschaffen.

Keine OpenSanctions-Daten, keine kostenpflichtigen Screeningdaten, keine
automatisierte PEP-Listenabfrage. Keine E-Mail oder Meldung an Behörden.

## Nachweise

- `packages/tax/src/screening/screening.test.ts`: Parsergrenzen, Kandidaten,
  Geburtsdatenkonflikte, Kürzung und Aktualitätsprüfung.
- `packages/tax/src/screening/persistence.test.ts`: keine Rücknahme eines neueren
  Bestands, gleicher Hash ohne Duplikat, idempotente getrennte Folgeprüfungen.
- `packages/db/prisma/migrations/20260831130000_screening_fees/migration.sql`:
  neue Tabellen, RLS, Tenant-/Mandanten-FKs, Unveränderlichkeit.

Die Tests sind technische Nachweise, keine fachliche Freigabe und kein
vollständiger Test gegen eine produktive PostgreSQL-/Redis-Installation.
