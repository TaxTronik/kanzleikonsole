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
laufen über Storno + Neuausstellung. Entwürfe (Status „Entwurf") sind frei
bearbeitbar und löschbar.

**Statuslauf.** Entwurf → Versendet → Bezahlt; überfällige Rechnungen werden
täglich automatisch als „Überfällig" markiert (mit interner Benachrichtigung
an die anlegende Person). Storno ist aus jedem Status außer „Bezahlt"
möglich; „Bezahlt" und „Storniert" sind Endzustände.

**Archivkopie (GoBD).** Beim Versand einer XRechnung-/ZUGFeRD-Rechnung wird
die Rechnungsdatei **vor** der Festschreibung revisionssicher abgelegt
(10 Jahre, schreibgeschützt). Schlägt das fehl — z. B. weil die
Absenderdaten der Kanzlei unvollständig sind — wird der Versand abgebrochen
und der Grund angezeigt; die Rechnung bleibt Entwurf.

**Prüfprotokoll.** Anlage, Versand, Zahlung, Storno und jeder
XRechnung-/ZUGFeRD-Download werden in der Audit-Hash-Chain festgehalten.

## 2. In-App-Rechnung erstellen

1. **Rechnungen → Neue Rechnung** (nur aktive, GwG-verifizierte Mandanten
   sind wählbar).
2. Betreff, Daten und Positionen erfassen (Menge × Einzelpreis; Summen
   berechnet der Server). Der USt-Satz wird **je Position** gewählt
   (19 % / 7 % / 0 %) — Mischsätze auf einer Rechnung sind möglich, die
   Steuer wird je Satz gruppiert ausgewiesen und gerundet. Format wählen:
   XRechnung (Standard), ZUGFeRD oder PDF.
3. **Anlegen** → die Rechnung erhält ihre Nummer und steht als Entwurf
   auf der Detailseite.
4. Auf der Detailseite: **Als versendet markieren** (erstellt die
   GoBD-Archivkopie und schreibt fest), später **Als bezahlt markieren**.
   XRechnung-XML und ZUGFeRD-PDF lassen sich dort jederzeit herunterladen.

Hinweis: Für die E-Rechnungs-Erzeugung müssen die Kanzlei-Absenderdaten
(Einstellungen → Rechnungsdaten) vollständig sein — Name, Anschrift sowie
**E-Mail und Telefon** (Pflichtangaben der XRechnung) — ebenso die
Mandanten-Anschrift (Straße, PLZ, Ort).

### Stunden abrechnen

In der Mandantenakte unter **Abrechnung**: offene, abrechenbare
Zeiteinträge werden als eine Sammelposition oder je Eintrag einzeln in eine
neue Entwurfs-Rechnung übernommen; die Einträge sind danach mit der Rechnung
verknüpft und können nicht mehr gelöscht werden.

## 3. Extern-Modus: PDF-Rechnung hochladen

**Rechnungen → Neue Rechnung**: Mandant, Rechnungstyp (von der
Administration gepflegt, bestimmt die E-Mail-Vorlage), Nummer aus der
Rechnungssoftware, Daten, Bruttobetrag und das PDF (max. 10 MB). Beim
Speichern wird das PDF revisionssicher abgelegt (GoBD, 10 Jahre), die
Rechnung gilt als versendet, und alle aktiven Portal-Kontakte des Mandanten
mit Benachrichtigungs-Opt-in erhalten eine E-Mail mit dem PDF im Anhang.

## 4. Rechnungen im Mandanten-Portal

Mandanten sehen unter **Rechnungen** alle Rechnungen außer Entwürfen
(inklusive stornierter, als „Storniert" gekennzeichnet) mit Nummer, Betreff,
Beträgen, Fälligkeit und Status. Über **Öffnen** laden sie das Rechnungs-PDF
(die archivierte ZUGFeRD-Datei bzw. das hochgeladene externe PDF).

## 5. Auswertungen und Export

Die Rechnungsliste filtert nach Status; der **CSV-Export** liefert die
Liste für Auswertungen (begrenzte Zeilenzahl mit Hinweis bei Kürzung; jeder
Export wird protokolliert). Das Berichte-Modul zeigt offene/überfällige
Summen und den Jahresumsatz.

## 6. Häufige Meldungen

| Meldung | Bedeutung | Was tun |
|---|---|---|
| „Versand abgebrochen — GoBD-Archivkopie konnte nicht erstellt werden: …" | Absender- oder Mandantendaten unvollständig | Kanzlei-Rechnungsdaten bzw. Mandanten-Anschrift vervollständigen, erneut versenden |
| „Statuswechsel … ist nicht zulässig" | Statuslauf erlaubt den Schritt nicht (z. B. bezahlte Rechnung stornieren) | ggf. Korrektur über neue Rechnung |
| „Rechnungsnummer existiert bereits." (Extern-Modus) | Nummer des Fremdsystems schon erfasst | Nummer prüfen |
| „Mandant ist nicht aktiv (GwG-Prüfung ausstehend)." | Rechnungen nur an GwG-verifizierte Mandanten | GwG-Prüfung abschließen |
| „Dieser Eintrag ist bereits abgerechnet …" | Zeiteintrag hängt an einer Rechnung | Eintrag bleibt als Beleg erhalten |
