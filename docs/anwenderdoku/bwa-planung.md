# BWA, Hochrechnung und Planung

Dieses Kapitel beschreibt das tenantweise aktivierbare BWA-Modul für Kanzlei
und Mandantenportal. Bei deaktiviertem Modul sind Navigation, direkte Seiten
und serverseitige Aktionen gesperrt. Die fachliche Würdigung der BWA und der
Planannahmen bleibt Aufgabe der Kanzlei.

## 1. BWA importieren und prüfen

Im Mandantenprofil unter **BWA** können Mitarbeiter periodenbezogene Werte
importieren. Unterstützt werden die in der Oberfläche angebotenen strukturierten
Formate; Datei, Zeitraum und Mandant werden serverseitig erneut geprüft. Ein
Import ersetzt keine Buchführung und keine DATEV-Synchronisation. Prüfen Sie
nach dem Import insbesondere:

1. Mandant und Wirtschaftsjahr,
2. enthaltene Monate und Vorjahreswerte,
3. Umsatzerlöse, Gesamtleistung, Material-/Personalkosten, Betriebsergebnis,
   Ergebnis vor Steuern und vorläufiges Ergebnis,
4. auffällige Lücken oder Vorzeichen.

Die Periodenansicht zeigt Kennzahlen, Vergleiche und Liquiditätsindikatoren.
Portalnutzer sehen BWA-Daten nur, wenn das Portal-Feature **BWA-Ansicht** für
die Kanzlei aktiviert ist.

Für die unterstützte DATEV-Gliederung werden Umsatzerlöse (1020), Gesamtleistung
(1051), Betriebsergebnis (1300) und Ergebnis vor Steuern (1345) getrennt behandelt.
Fehlt die Umsatz- oder Vorsteuerposition, bleibt diese Kennzahl leer. Gesamtleistung
und Betriebsergebnis ersetzen sie nicht. Betriebliche Kosten umfassen Material-
und Wareneinkauf sowie die Kostenartensumme; fehlende Bestandteile werden nicht
als null Euro angenommen (`BWA-IMPORT-MAPPING-001`).

Der einfache Cashflow-Proxy addiert nur vorhandene Abschreibungen zum
vorläufigen Ergebnis (DATEV 1240, Addison 3100). Ohne bekannte Abschreibungen
bleibt der Proxy leer. Er berücksichtigt keine tatsächlichen Zahlungsbewegungen
und ist keine Liquiditätsrechnung.

## 2. Hochrechnung

TaxTronik stellt zwei Rechenwege nebeneinander dar:

- **Lineare Run-rate:** Der bisherige Periodenverlauf wird mit
  `12 / erfasste Monate` auf das Gesamtjahr fortgeschrieben. Die Spanne wird
  mit zunehmender Datenabdeckung enger; eine Saisongewichtung findet nicht
  statt.
- **Vorjahrestrend:** Die Regression verwendet mindestens zwei rechnerisch
  zwölfmonatige `YEAR`-Perioden, die vollständig vor dem Zieljahr enden.
  Zieljahr, Zukunftsjahre und jahresübergreifende Perioden, die erst im
  Zieljahr enden, werden nach `BWA-PROJECTION-001` ausgeschlossen.

Abweichende Ergebnisse sind kein technischer Fehler, sondern zeigen die
unterschiedlichen Annahmen. Die Oberfläche weist die Datenbasis als Zahl der
erfassten Monate (`N/12`) aus. Eine Projektion ist keine Steuer- oder
Liquiditätsgarantie.

Ohne vorhandenes Ergebnis vor Steuern werden weder dessen Hochrechnung noch
eine darauf aufbauende Steuerpauschale angezeigt. Auch die Steuerschätzung in
der Periodenansicht verwendet kein vorläufiges Nachsteuerergebnis als Ersatz
(`BWA-TAX-ESTIMATE-001`).

## 3. Planungen und Szenarien

Unter **BWA → Planungen** können Kanzleimitarbeiter mehrere benannte
Jahresplanungen mit Gesamtwerten je Planachse anlegen und gegen Ist und die
bevorzugte verfügbare Hochrechnung vergleichen.
Mandanten können eigene Planungen nur erstellen, wenn zusätzlich das
Portal-Feature **BWA-Planung** aktiviert ist. Herkunft, Ersteller und
Änderungszeitpunkt bleiben sichtbar; eine Mandantenplanung überschreibt keine
Kanzleiplanung.

Empfohlener Ablauf:

1. Ausgangsperiode und Szenarionamen festlegen.
2. Erlös-, sonstige Ertrags-, Kosten- und Steuerannahmen erfassen.
3. Plan gegen Ist und die bevorzugte verfügbare Hochrechnung vergleichen.
4. Annahmen mit dem Mandanten abstimmen und fachlich dokumentieren.
5. Veraltete Szenarien nicht als aktuelle Prognose weiterverwenden.

Eine automatische Vorbelegung steht nur für vollständige, zu den Planachsen
passende Ausgangswerte zur Verfügung. Fehlen Einzelpositionen oder stimmt die
Summe nicht centgenau mit dem Ergebnis vor Steuern überein, zeigt TaxTronik den
Grund und lässt die manuelle Planung zu. DATEV-Bestandsänderungen, aktivierte
Eigenleistungen und neutraler Aufwand können in den vorhandenen Planachsen
nicht getrennt vorbelegt werden; sie müssen für eine automatische Übernahme
ausdrücklich mit null Euro vorliegen. Ungeklärte Differenzen werden nicht als
sonstige Erträge eingefügt. Auch eine lesbare kompakte Addison-BWA kann deshalb
für eine vollständige automatische Planvorbelegung unzureichend sein.

Manuelle BWA-Daten haben keine automatische Positionszuordnung und werden deshalb nur manuell geplant. Im Dashboard und Planvergleich bleiben fehlende Werte ausdrücklich unbekannt; sie werden weder als null Euro noch als berechnetes Ergebnis ergänzt. Die Umsatzzeile vergleicht reine Umsatzerlöse ohne sonstige Erträge.

Bereits gespeicherte und manuell bearbeitete Planungen bleiben unverändert.
Die korrigierte Kennzahlzuordnung wird beim erneuten Lesen auch auf historische
BWA-Rohpositionen angewendet. Prüfen Sie frühere Planvorbelegungen gegen die
Original-BWA; insbesondere können zuvor Gesamtleistung als Umsatz oder
Betriebsergebnis als Vorsteuerergebnis übernommen worden sein.

## 4. Grenzen

- Kein Live-Banking und keine DATEV-API-Synchronisation.
- Keine automatische fachliche Freigabe von Annahmen.
- Ergebnisse hängen vollständig von importierten Daten und eingegebenen
  Szenarien ab.
- Die fest hinterlegten Positionsnummern gelten nur für die beschriebenen
  BWA-Schemata. Technisch richtige Kennzahlen sind keine steuerliche Überleitung;
  die USt-Pauschale berücksichtigt etwa keine gemischten oder steuerfreien Umsätze.
- Exporte und Screenshots müssen außerhalb von TaxTronik nach dem
  Berechtigungskonzept der Kanzlei behandelt werden.
