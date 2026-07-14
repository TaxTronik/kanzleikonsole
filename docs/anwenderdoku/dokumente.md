# Benutzerhandbuch: Dokumente und Archiv

Dieses Kapitel beschreibt die Arbeit mit Dokumenten in TaxTronik — für
Kanzlei-Mitarbeiter (Staff-Oberfläche) und im letzten Abschnitt für
Mandanten (Portal). Stand: siehe Versionsangabe der Installation
(Administration → „Installiert").

## 1. Grundbegriffe

**Dokument und Versionen.** Jede Datei wird als Dokument mit mindestens
einer Version geführt. Wird eine neue Fassung hochgeladen („Neue Version"),
bleibt jede frühere Version unverändert erhalten — bei GoBD-geschützten
Dokumenten technisch unveränderbar (Schreibschutz auf Speicherebene).

**Datei-Typ und Schutzstufe.** Beim Hochladen wird ein Datei-Typ gewählt
(z. B. „GoBD Rechnung"). Der Typ bestimmt die Schutzstufe:

| Schutzstufe | Bedeutung                                                                                                                                     | Aufbewahrung                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GoBD        | steuerlich aufbewahrungspflichtig; Versionen sind bis Fristablauf von **niemandem** löschbar oder veränderbar, auch nicht von Administratoren | je Datei-Typ 6, 8 oder 10 Jahre ab dem einschlägigen Jahresende                                                                         |
| GwG         | Identifizierungs-/Nachweisdokumente nach Geldwäschegesetz; geschützt, aber nach § 8 Abs. 4 GwG fristgerecht zu **vernichten**                 | grundsätzlich 5 Jahre ab dem gesetzlichen Fristbeginn; andere Gesetze können länger verpflichten, spätestens nach 10 Jahren Vernichtung |
| Ohne        | alle übrigen Unterlagen                                                                                                                       | keine erzwungene Frist                                                                                                                  |

Eine **Herabstufung** der Schutzstufe ist nicht möglich; eine Höherstufung aus
„Ohne" (z. B. „Ohne" → „GoBD") ist möglich. GwG-Nachweise können nicht nach
GoBD umklassifiziert werden, weil ihre eigenständige gesetzliche
Vernichtungsfrist und Review-Queue erhalten bleiben müssen. Falls dieselben
Bytes zusätzlich GoBD-relevant sind, legen Sie dafür ein separates Dokument an.

Bei den mitgelieferten GoBD-Typen gelten aktuell: **Vertrag 6 Jahre**,
**Rechnung/Buchungsbeleg 8 Jahre** und **Steuerunterlage 10 Jahre**. Ob eine
Unterlage im Einzelfall anders einzuordnen oder länger aufzubewahren ist,
bleibt fachlich zu prüfen.

**Virenscan.** Jede hochgeladene Datei wird **vor** der Annahme auf
Schadsoftware geprüft. Eine auffällige Datei wird abgewiesen und nirgends
gespeichert. Ist der Virenscanner nicht erreichbar, wird der Upload
ebenfalls abgewiesen (Sicherheitsprinzip: im Zweifel keine Annahme) —
in dem Fall später erneut versuchen und ggf. die Administration informieren.

**Freigabe.** Von der Kanzlei hochgeladene Dokumente sind zunächst
**privat** (für Mandanten unsichtbar). Erst die ausdrückliche Freigabe macht
ein Dokument im Mandanten-Portal sichtbar. Vom Mandanten selbst hochgeladene
Dateien sind für ihn automatisch sichtbar.

**Maximale Dateigröße:** 25 MiB pro Datei (in einzelnen Bereichen wie
Formular-Anhängen oder Rechnungs-PDFs: 10 MB).

## 2. Der Dokumenten-Explorer (Kanzlei)

Erreichbar über **Dokumente** (kanzleiweit, gegliedert nach Mandantentyp
und „Kanzlei-intern") sowie als Tab **Dokumente** in jeder Mandantenakte.

### Hochladen

1. In den gewünschten Bereich/Ordner navigieren.
2. **Hochladen** wählen oder Dateien direkt aus dem Datei-Manager in das
   Fenster ziehen.
3. Datei-Typ wählen (bestimmt die Schutzstufe — siehe oben), optional Titel
   anpassen.
4. Nach „Virus-Scan & Verarbeitung…" erscheint das Dokument in der Liste.

### Ordnen und Finden

- **Ordner** anlegen, umbenennen, verschieben; Dokumente per Drag & Drop
  zwischen Ordnern verschieben. Beim Löschen eines Ordners bleiben alle
  Dokumente erhalten (sie rücken eine Ebene nach oben).
- **Suche** durchsucht Titel im aktuellen Bereich (auch bei Tippfehlern
  tolerant).
- Listen zeigen maximal 1000 Einträge und weisen darauf hin, wenn gekürzt
  wurde — dann Suche oder Ordnerstruktur nutzen.

### Mehrfach-Aktionen

Mehrere Einträge auswählen (Checkboxen) für: **Freigeben/Privat**,
**Verschieben**, **Löschen**, **ZIP-Download** (auch ganze Ordner; sehr
große Auswahlen werden mit Hinweis abgelehnt — in Teilen herunterladen).

### Dokument-Detailseite

Zeigt die vollständige **Versionshistorie** (Nummer, Datum, Größe,
Prüfsumme, Scan-Status), erlaubt **Neue Version hochladen** und bei
Eingängen die **Empfangsbestätigung**. Bei GoBD-Dokumenten weist die Seite
darauf hin, dass bestehende Versionen unveränderlich sind.

### Freigeben an Mandanten

Pro Dokument (Schalter in der Zeile) oder als Mehrfach-Aktion. Nur
Dokumente, die einem Mandanten zugeordnet sind, lassen sich freigeben —
kanzlei-interne Dateien nicht. Jede Freigabe und jeder Entzug wird im
Prüfprotokoll festgehalten.

### Löschen und Papierkorb

„Löschen" blendet ein Dokument aus (Papierkorb-Ansicht über den Filter
„Gelöschte anzeigen"), die Datei bleibt unter dem konfigurierten Object-Lock
aufbewahrt und ist wiederherstellbar. Ein endgültiges Vernichten gibt es nur
im gesetzlich geregelten GwG-Verfahren (Abschnitt 4).

## 3. Datei-Typen verwalten (Administration)

Unter **Administration → Datei-Typen & Schutzstufen**: Sieben Kern-Typen
sind fest vorgegeben (nicht änderbar). Eigene Typen können angelegt werden;
die Schutzstufe wird **bei der Anlage** festgelegt und ist danach bewusst
unveränderbar. Typen mit vorhandenen Dokumenten lassen sich nicht löschen —
stattdessen deaktivieren.

## 4. GwG-Pflichtvernichtung (Administration)

GwG-Unterlagen müssen nach Fristablauf vernichtet werden (§ 8 Abs. 4 GwG).
TaxTronik vernichtet **nie automatisch**: Unter **Administration →
GwG-Pflichtlöschung** erscheinen fällige Belege als Prüfliste;
Administratoren erhalten zusätzlich eine Benachrichtigung. Die Vernichtung
wird je Beleg ausdrücklich bestätigt, entfernt alle Dateiversionen
endgültig und wird im Prüfprotokoll nachgewiesen.

## 5. Häufige Meldungen

| Meldung/Situation                            | Bedeutung                                                        | Was tun                                             |
| -------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| Datei abgewiesen, Hinweis auf Schadsoftware  | Virenscan-Treffer; Datei wurde nicht gespeichert                 | Quelle prüfen; Datei nicht erneut hochladen         |
| Upload schlägt mit Scan-/Serverfehler fehl   | Virenscanner nicht erreichbar (Annahme im Zweifel verweigert)    | später erneut versuchen; Administration informieren |
| „Datei zu groß"                              | Größenlimit überschritten (25 MiB bzw. 10 MiB)                   | Datei verkleinern/aufteilen                         |
| „Gleichzeitiger Upload … erneut versuchen"   | zwei neue Versionen gleichzeitig hochgeladen                     | erneut hochladen                                    |
| „Herabstufung nicht möglich"                 | Schutzstufe kann nur erhöht werden                               | ggf. neuen Typ mit höherer Stufe wählen             |
| ZIP-Download abgelehnt (zu groß/ausgelastet) | Auswahl überschreitet das Limit oder es laufen bereits Downloads | Auswahl verkleinern bzw. kurz warten                |

## 6. Dokumente im Mandanten-Portal

Mandanten sehen unter **Dokumente** ausschließlich die für sie
freigegebenen Unterlagen (Titel, Typ, Größe, Datum) und können sie ansehen
bzw. herunterladen. Eigene Dateien laden Mandanten — sofern die Kanzlei die
Funktion aktiviert hat — direkt hoch oder als Antwort auf eine Anforderung;
auch diese Uploads durchlaufen den Virenscan. Eine Versionshistorie ist im
Portal nicht sichtbar; es zählt immer der aktuelle Stand.
