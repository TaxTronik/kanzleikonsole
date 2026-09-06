# Mandanten-Timeline

Die Staff-Seite `/staff/clients/[id]/timeline` zeigt Ereignisse aus den aktuellen
fachlichen Datensätzen eines Mandanten. Sie liest in der bestehenden
Tenant-Transaktion und verändert weder Status noch Nachweise. Das Audit-Protokoll
bleibt die separate Quelle für vollständig protokollierte Änderungen und Zugriffe.

## Auswahl und Reihenfolge

`apps/web/src/server/timeline/records.ts` lädt Dokumente, Anforderungen, Antworten,
Telefonzettel, Rechnungen, GwG-Prüfungen, Vollmachten, Bescheide, erledigte
Steuertermine und Workflow-Schritte sowie Subsumtionen. Bei Vorgängen mit mehreren
Zeitfeldern erhält jedes Ereigniszeitfeld eine eigene begrenzte Abfrage. So bleibt
etwa eine heute bezahlte alte Rechnung sichtbar, auch wenn viele jüngere Entwürfe
vorliegen. Das Anlagedatum allein darf eine spätere Zahlung oder Signatur nicht
aus der Auswahl verdrängen.

Die 18 Quellenabfragen laden jeweils höchstens `limit` Datensätze mit passenden
Mandantenfiltern. Mehrfach geladene Datensätze werden vor der Projektion anhand
ihrer ID zusammengeführt. Die bestehenden Tenant-/Mandantenindizes beziehungsweise
Indizes auf Elternbeziehungen begrenzen die jeweilige Suche. Die zusätzlichen
Zeitabfragen benötigen Datenbanksortierungen; dedizierte Zeitindizes für jede
Quelle oder Messungen großer Produktionsbestände sind damit nicht nachgewiesen.
Die Abfragen bleiben auf derselben Transaktionsverbindung und stellen keine
parallelen Datenbankverbindungen her.

`events.ts` enthält getrennte Projektionen je Quelle; `build.ts` übernimmt
Vertraulichkeitsprüfung, Zeitgrenze, gemeinsame Sortierung und das abschließende
Ereignislimit. Die Ereignisse stehen absteigend nach Zeitpunkt, bei Gleichstand
aufsteigend nach Ereignis-ID. Die begrenzten Datenbankabfragen verwenden ebenfalls
eine ID als feste zweite Sortierspalte.

`before` ist unverändert eine **strikte Datumsgrenze**: Ereignisse am oder nach
diesem Zeitpunkt werden ausgeschlossen. Auch weitere Ereignisse eines wegen
seines früheren Zeitfelds geladenen Datensatzes müssen diese Grenze einhalten.
Ein Datum allein ist kein verlustfreier Cursor für ein auf mehrere Seiten
verteiltes Zeitgleichstandssegment. Die derzeitige Oberfläche verwendet deshalb
keinen solchen Cursor, sondern ein wachsendes Limit von 20 bis höchstens 500.
Nicht endliche oder nicht numerische Eingaben fallen auf 100 zurück; Bruchteile
werden abgeschnitten. An der Obergrenze gibt es keinen wirkungslosen
„Mehr Ereignisse laden“-Link. Tagesgruppen und sichtbare Datumsangaben verwenden
einheitlich `Europe/Berlin`, auch nahe Mitternacht in Sommer- und Winterzeit.

## Fachliche Zuordnung und Grenzen

Die gespeicherten Zustände und Zeitfelder bleiben maßgeblich:
`REQ-LIFECYCLE-001`, `INV-LIFECYCLE-FREEZE-001`, `GWG-RISK-REVIEW-001`,
`POA-LIFECYCLE-001` und `RISK-ARCHIVE-SNAPSHOT-001`. Die Timeline entscheidet
weder über Abschluss, Zahlung, GwG-Freigabe noch Signatur oder Archivierung.
Insbesondere erzeugt die bessere Auswahl keinen neuen fachlichen Nachweis.

Die Titel vertraulicher Subsumtionen bleiben für Unbeteiligte neutral; das gilt
auch für neu in die Auswahl gelangende Archivierungsereignisse. Voller Zugriff
oder eine persönliche Zuordnung wird unverändert geprüft. Tenant-Kontext und
Objektrechte bleiben nach `ACCESS-TENANT-RLS-001` erforderlich.

Die Timeline rekonstruiert keine verschwundenen Zwischenzustände aus dem Audit:
Wird etwa ein Abschlussfeld bei Wiederöffnung geleert, ist der frühere Abschluss
nicht mehr aus diesem Datensatz ableitbar. GwG-Ablehnungen besitzen derzeit kein
separates Ablehnungsdatum und verwenden weiterhin das Anlagedatum als
Näherungswert. Diese bekannte Anzeigegrenze wird durch die Aggregationskorrektur
nicht behoben; `updatedAt` wird nicht als erfundener Entscheidungszeitpunkt benutzt.

## Technische Nachweise

`apps/web/src/server/timeline/__tests__/timeline-order.test.ts` führt den echten
Aggregator gegen Persistenz-Doubles aus, die Filter, Sortierung und Limit vor
der Ereignisprojektion anwenden. 17 Regressionen belegen aktuelle Folgeereignisse
alter Vorgänge, Mandantenzuordnung, strikte Zeitgrenzen, Gleichstände und
Duplikatfreiheit. Die bestehenden Vertraulichkeitsfälle und ein zusätzlicher
Archivierungsfall liegen in `timeline-vertraulich.test.ts`.

Die sieben Renderfälle in
`apps/web/src/app/staff/(protected)/clients/[id]/timeline/__tests__/page.test.tsx`
prüfen die tatsächliche Seite mit ungültigen beziehungsweise gebrochenen Limits,
der Obergrenze, dem normalen Nachladen und Berliner Tagesgruppen. Diese Tests
ersetzen weder einen PostgreSQL-Ausführungsplan noch einen Browser-Lasttest.
