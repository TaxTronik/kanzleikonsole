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
3. Erlöse, Material-/Personalkosten und Ergebnis,
4. auffällige Lücken oder Vorzeichen.

Die Periodenansicht zeigt Kennzahlen, Vergleiche und Liquiditätsindikatoren.
Portalnutzer sehen BWA-Daten nur, wenn das Portal-Feature **BWA-Ansicht** für
die Kanzlei aktiviert ist.

## 2. Hochrechnung

TaxTronik stellt zwei Rechenwege nebeneinander dar:

- **Lineare Run-rate:** Der bisherige Periodenverlauf wird mit
  `12 / erfasste Monate` auf das Gesamtjahr fortgeschrieben. Die Spanne wird
  mit zunehmender Datenabdeckung enger; eine Saisongewichtung findet nicht
  statt.
- **Vorjahrestrend:** Aus mindestens zwei vollständigen Vorjahren wird eine
  lineare Regression mit eigener Unsicherheitsspanne gebildet.

Abweichende Ergebnisse sind kein technischer Fehler, sondern zeigen die
unterschiedlichen Annahmen. Die Oberfläche weist die Datenbasis als Zahl der
erfassten Monate (`N/12`) aus. Eine Projektion ist keine Steuer- oder
Liquiditätsgarantie.

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

## 4. Grenzen

- Kein Live-Banking und keine DATEV-API-Synchronisation.
- Keine automatische fachliche Freigabe von Annahmen.
- Ergebnisse hängen vollständig von importierten Daten und eingegebenen
  Szenarien ab.
- Exporte und Screenshots müssen außerhalb von TaxTronik nach dem
  Berechtigungskonzept der Kanzlei behandelt werden.
