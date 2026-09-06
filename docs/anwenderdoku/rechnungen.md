# Benutzerhandbuch: Rechnungen

Dieses Kapitel beschreibt die Rechnungsstellung in TaxTronik. Welcher der
beiden Betriebsmodi gilt, legt die Administration fest (Einstellungen →
Module): **In-App** (Rechnungen entstehen in TaxTronik) oder **Extern**
(Rechnungen kommen als PDF aus einer zentralen Rechnungssoftware und werden
hier nur abgelegt und zugestellt). Ist das Modul ausgeschaltet, sind die
Rechnungsfunktionen ausgeblendet und serverseitig gesperrt.

## 1. Grundprinzipien (beide Modi)

**Rechnungsnummern.** Im In-App-Modus vergibt TaxTronik die Nummer beim
Anlegen **automatisch, fortlaufend und lückenlos** je Kalenderjahr (Format
`JJJJ-NNNN`). Eine manuelle Eingabe gibt es nicht; stornierte Rechnungen
behalten ihre Nummer (der Storno-Status erklärt sie). Im Extern-Modus wird
die Nummer des Fremdsystems eingetragen; doppelte Nummern weist das System ab.

**Festschreibung.** Mit dem Versand ist eine Rechnung festgeschrieben:
Beträge, Positionen, Daten und Nummer sind danach **technisch unveränderbar**
(auf Datenbankebene erzwungen, auch für Administratoren) — Korrekturen
laufen über Storno + Neuausstellung. Auch Entwürfe lassen sich in der
aktuellen Oberfläche nicht nachträglich bearbeiten oder löschen; ein
verworfener Entwurf wird storniert, damit seine Nummer nachvollziehbar bleibt.

**Statuslauf.** Entwurf → Versendet → Bezahlt; überfällige Rechnungen werden
täglich automatisch als „Überfällig" markiert (mit interner Benachrichtigung
an die anlegende Person). Storno ist aus jedem Status außer „Storniert"
möglich. Bei einer bereits bezahlten Rechnung entsteht ebenfalls ein
Korrekturbeleg; eine erforderliche Rückzahlung wird außerhalb von TaxTronik
abgewickelt. „Storniert" ist der Endzustand.

**Archivkopie (GoBD).** Beim Versand einer XRechnung-/ZUGFeRD-Rechnung wird
die Rechnungsdatei **vor** der Festschreibung mit Object-Lock abgelegt
(8 Jahre ab dem einschlägigen Jahresende, schreibgeschützt). Schlägt das fehl — z. B. weil die
Absenderdaten der Kanzlei unvollständig sind — wird der Versand abgebrochen
und der Grund angezeigt; die Rechnung bleibt Entwurf.

**Briefkopf.** Neu erzeugte ZUGFeRD-Rechnungs-PDFs übernehmen ein helles
Branding-Logo im PNG-/JPEG-Format sowie Organisationsname,
Adress-/Kontaktzeilen und Fußnote aus
Einstellungen → Branding. Leere Felder für Organisationsname, Anschrift und
Kontakt fallen auf die hinterlegten Rechnungs-Absenderdaten zurück; eine leere
freie Fußnote wird weggelassen. Eine bereits archivierte Rechnung bleibt
byte-stabil und wird durch spätere Einstellungsänderungen nicht umgeschrieben.
Extern hochgeladene oder signierte PDF-Belege werden ebenfalls nie verändert.
WebP-Logos bleiben für das Web-Branding nutzbar, werden vom
Rechnungs-PDF-Generator derzeit aber nicht eingebettet.

**Prüfprotokoll.** Anlage, Versand, Zahlung, Storno und jeder
XRechnung-/ZUGFeRD-Download werden in der Audit-Hash-Chain festgehalten.

## 2. In-App-Rechnung erstellen

1. **Rechnungen → Neue Rechnung** (nur aktive, GwG-verifizierte Mandanten
   sind wählbar).
2. Betreff, Daten und Positionen erfassen (Menge × Einzelpreis; Summen
   berechnet der Server). Der USt-Satz wird **je Position** gewählt
   (19 % / 7 % / 0 %) — Mischsätze auf einer Rechnung sind möglich, die
   Steuer wird je Satz gruppiert ausgewiesen und gerundet. Format wählen:
   XRechnung (Standard) oder ZUGFeRD.
3. **Anlegen** → die Rechnung erhält ihre Nummer und steht als Entwurf
   auf der Detailseite.
4. Auf der Detailseite: **Als versendet markieren** (erstellt die
   GoBD-Archivkopie und schreibt fest), später **Als bezahlt markieren**.
   XRechnung-XML und ZUGFeRD-PDF lassen sich dort jederzeit herunterladen.
   Bei ausgestellten Rechnungen liefert der direkte ZUGFeRD-Download dieselben
   archivierten PDF-Bytes; er erzeugt keine abweichende zweite Fassung.
   Downloads eines Entwurfs sind dagegen nur aktuelle Kontrollfassungen und
   werden noch nicht revisionssicher archiviert.

Hinweis: Rechnungen anlegen und versenden dürfen nur Mitarbeiter mit dem
jeweiligen Recht (_Rechnungen anlegen/bearbeiten_ bzw. _Rechnungen
versenden_, siehe [Administration](administration.md)); Admin/Partner haben
beide immer.

Hinweis: Für die E-Rechnungs-Erzeugung müssen die Kanzlei-Absenderdaten
(Einstellungen → Rechnungsdaten) vollständig sein — Name, Anschrift sowie
**E-Mail und Telefon** (Pflichtangaben der XRechnung) — ebenso die
Mandanten-Anschrift (Straße, PLZ, Ort).

### Stunden abrechnen

In der Mandantenakte unter **Abrechnung**: offene, abrechenbare
Zeiteinträge werden als eine Sammelposition oder je Eintrag einzeln in eine
neue Entwurfs-Rechnung übernommen; die Einträge sind danach mit der Rechnung
verknüpft und können nicht mehr gelöscht werden.
Der Leistungszeitraum enthält den ersten und letzten betroffenen Kalendertag
in der Zeitzone Europe/Berlin. Die abrechenbaren Stunden ergeben sich aus der
tatsächlich verstrichenen Zeit, auch bei Sommer-/Winterzeitwechseln
(Fachkatalog `INV-TIME-ENTRY-CLAIM-001`).

### StBVV-Kalkulation übernehmen

Bei aktiviertem Gebührenrechner lässt sich eine gespeicherte Kalkulation im
In-App-Modus als neue XRechnung übernehmen. Die Rechnung bleibt zunächst
Entwurf; wiederholtes Übernehmen öffnet dieselbe Rechnung. Vor dem Versand
sind insbesondere Leistungszeitraum und weitere Rechnungsangaben zu prüfen.
Der normale Versand erstellt die XML-Datei und das PDF-Archiv
(Fachkatalog `STBVV-CALCULATION-001`).
War eine ältere Übernahme als PDF-Entwurf ohne Rechnungsdatei stehengeblieben,
korrigiert die erneute Übernahme das Format. Bereits ausgestellte Rechnungen
und vorhandene Archivdateien bleiben unverändert.

Eine Stornierung erzeugt einen negativen Korrekturbeleg mit Bezug auf die
ursprüngliche Rechnung. Bereits ausgestellte Archivdateien bleiben erhalten
(Fachkatalog `INV-STORNO-REFERENCE-001`).

## 3. Extern-Modus: PDF-Rechnung hochladen

**Rechnungen → Neue Rechnung**: Mandant, Rechnungstyp (von der
Administration gepflegt, bestimmt die E-Mail-Vorlage), Nummer aus der
Rechnungssoftware, Daten, Bruttobetrag und das PDF (max. 10 MB). Beim
Speichern wird das PDF mit Object-Lock abgelegt (Rechnung/Buchungsbeleg,
achtjährige Aufbewahrung nach § 147 Abs. 3 AO bzw. § 14b UStG), die
Rechnung gilt als versendet, und alle aktiven Portal-Kontakte des Mandanten
mit Benachrichtigungs-Opt-in erhalten eine E-Mail mit dem PDF im Anhang.

## 4. Rechnungen im Mandanten-Portal

Mandanten sehen unter **Rechnungen** ausgestellte Rechnungen mit Nummer,
Betreff, Beträgen, Fälligkeit und Status. Ein später stornierter, zuvor
versendeter Beleg bleibt als historischer Nachweis sichtbar und ist als
„Storniert" gekennzeichnet. Entwürfe und vor dem Versand stornierte Entwürfe
bleiben ausschließlich kanzleiintern (Fachkatalog `INV-PORTAL-SHARING-001`).
Je Rechnung stehen zwei Schaltflächen: das
**Auge** zeigt das Rechnungs-PDF direkt im Browser, der **Pfeil** lädt es
herunter (die archivierte ZUGFeRD-Datei bzw. das hochgeladene externe PDF).

## 5. Auswertungen und Export

Die Rechnungsliste filtert nach Status; der **CSV-Export** liefert die
Liste für Auswertungen (begrenzte Zeilenzahl mit Hinweis bei Kürzung; jeder
Export wird protokolliert). Das Berichte-Modul zeigt offene/überfällige
Summen und den Jahresumsatz.

## 6. Häufige Meldungen

| Meldung                                                                  | Bedeutung                                                                                  | Was tun                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| „Versand abgebrochen — GoBD-Archivkopie konnte nicht erstellt werden: …" | Absender- oder Mandantendaten unvollständig                                                | Kanzlei-Rechnungsdaten bzw. Mandanten-Anschrift vervollständigen, erneut versenden |
| „Statuswechsel … ist nicht zulässig"                                     | Statuslauf erlaubt den Schritt nicht (z. B. bereits stornierte Rechnung erneut stornieren) | Status prüfen; Korrekturbelege über die vorgesehene Storno-Aktion anlegen          |
| „Rechnungsnummer existiert bereits." (Extern-Modus)                      | Nummer des Fremdsystems schon erfasst                                                      | Nummer prüfen                                                                      |
| „Mandant ist nicht aktiv (GwG-Prüfung ausstehend)."                      | Rechnungen nur an GwG-verifizierte Mandanten                                               | GwG-Prüfung abschließen                                                            |
| „Dieser Eintrag ist bereits abgerechnet …"                               | Zeiteintrag hängt an einer Rechnung                                                        | Eintrag bleibt als Beleg erhalten                                                  |
