# Tax-CMS

Das Tax-CMS unterstützt die Kanzlei dabei, das Tax-Compliance-Programm eines
Mandanten aufzubauen, zu dokumentieren und nachzuhalten: Grundelemente,
Risiken, Kontrollen, Durchführungen, Feststellungen und Ereignisse. Es ist ein
**Werkzeug**. Statusangaben sind Arbeitsstände der Kanzlei; das Tax-CMS trifft
**keine Aussage über Angemessenheit oder Wirksamkeit** eines
Tax-Compliance-Management-Systems und ersetzt keine unabhängige Prüfung.

> Das Modul „Tax-CMS“ ist ein eigenes Modul und nicht dasselbe wie
> „Subsumtion / TCMS“ (Sachverhaltsanalyse, siehe
> [Subsumtion, TCMS und Quantenlos](subsumtion-tcms-quantenlos.md)).

Dieses Kapitel beschreibt den aktuellen Stand: Portfolio, Cockpit des
Mandanten, Kontakte & Rollen und die Übersicht im Mandanten-Portal. Die
übrigen Bereiche (Einrichtung, Profil, Beschreibung, Risiken, Kontrollen,
Durchführungen, Feststellungen, Ereignisse, Länder, Kalender, Prüfung,
Kommunikation) sind in der Navigation bereits vorgesehen und folgen.

## 1. Voraussetzungen

- **Anbindung durch den Betrieb.** Das Tax-CMS läuft als eigener Dienst neben
  TaxTronik ([TCMS-Betrieb](../operations/tcms-betrieb.md)). Ohne Anbindung
  erscheint kein Menüpunkt; eine direkt aufgerufene Seite zeigt „Tax-CMS nicht
  eingerichtet“.
- **Modul einschalten.** Admins und Partner schalten unter _Einstellungen →
  Module_ das Modul „Tax-CMS“ ein (Standard: aus). Ist es aus, sind die
  Seiten nicht erreichbar.

## 2. Wer darf was?

- **Sehen:** Wer einen Mandanten in TaxTronik öffnen darf, sieht auch dessen
  Tax-CMS – mit denselben Regeln für eingeschränkte und vertrauliche Mandate.
  Ohne Zugriff auf den Mandanten gibt TaxTronik nichts an das Tax-CMS weiter.
- **Bearbeiten und würdigen:** Ob jemand bearbeiten, gegenzeichnen oder eine
  §-153-Würdigung festhalten darf, entscheidet das Tax-CMS. Grundlage sind die
  Angaben aus TaxTronik: Rolle Admin/Partner, Berufsträgereigenschaft und die
  Zuordnung als Berufsträgerin oder Hauptbearbeitung des Mandanten. Fehlt ein
  Recht, erscheint eine feste Meldung, etwa „Die §-153-Würdigung ist
  zuständigen Berufsträgerinnen und Berufsträgern vorbehalten.“
- **Rollen geändert?** Wurden Ihre Rollen geändert, während Sie angemeldet
  sind, erscheint „Bitte melden Sie sich erneut an, damit Ihre aktuellen
  Rechte gelten.“

## 3. Portfolio

_Mandatsarbeit → Tax-CMS_ zeigt alle Mandanten, die Sie sehen dürfen, mit
Phase, Teilbereich, offenen §-153-Würdigungen, Risikolage, Zeitraum und
fälligen Aufgaben. Die Kennzahlen oben fassen die Liste zusammen.

Filter: Suche nach Mandant, Phase (einschließlich „ohne Tax-CMS“), „nur meine
Mandate“ (zugeordnet als Berufsträgerin oder Hauptbearbeitung), „nur mit
Überfälligem“ und „nur mit Handlungsbedarf“. Ein Klick auf den Mandanten
öffnet sein Cockpit.

## 4. Cockpit des Mandanten

In der Mandantenakte führt der Reiter **Tax-CMS** zum Cockpit. Die
Unternavigation darunter enthält alle Bereiche des Tax-CMS.

- **Mandant noch nicht angelegt:** Das Cockpit bietet „Mandant im Tax-CMS
  anlegen“ an. Übernommen werden nur Name, Rechtsform und DATEV-Nummer aus
  TaxTronik; das Tax-CMS hält keine weiteren Stammdaten. Weicht der Name im
  Tax-CMS später von der Mandantenakte ab, bietet das Cockpit „Stammdaten
  übernehmen“ an. Ob Sie anlegen oder übernehmen dürfen, entscheidet das
  Tax-CMS.
- **Cockpit:** Phase und Teilbereich, offene §-153-Würdigungen, Stand der
  Grundelemente, Risikolage (Heatmap), laufender Wirksamkeitszeitraum, in
  14 Tagen fällige oder überfällige Durchführungen, offene Feststellungen,
  neue Ereignisse und Länder.
- **Stichtag:** Über das Datumsfeld im Kopf lässt sich ein früherer Stand
  ansehen. Die Anzeige übernimmt die Angaben des Tax-CMS zu diesem Tag.
- **Vertrauliche Feststellungen:** Wer an einer vertraulichen Feststellung
  nicht beteiligt ist, sieht nur „<Nummer> · Vertrauliche Feststellung“.
- **Namen:** Personen erscheinen mit ihrem Namen aus TaxTronik. Personen, die
  TaxTronik nicht (mehr) zuordnen kann, erscheinen als „Unbekannte Person“.

## 5. Kontakte & Rollen

Unter _Tax-CMS → Kontakte & Rollen_ ordnen Sie Kontakten des Mandanten Rollen
im Tax-CMS zu: **Gesetzliche Vertretung**, **Tax-Compliance-Beauftragte** und
**Mitarbeitende**, optional mit Funktion. Die Rollen steuern, was ein Kontakt
im Mandanten-Portal sieht und tun darf.

- Zur Auswahl stehen nur Kontakte dieses Mandanten; Rollen erhalten nur
  aktive Kontakte. Rollen entfernen geht auch bei inaktiven Kontakten.
- Die Kontaktdaten selbst pflegen Sie wie gewohnt in der Mandantenakte.
- Ob Sie Rollen pflegen dürfen, entscheidet das Tax-CMS.

## 6. Mandanten-Portal

Kontakte mit Portalzugang sehen unter **Tax-CMS** den Stand des Programms,
ihre Aufgaben, die Möglichkeit, neue Ereignisse zu melden, und die letzten
Meldungen. Was ein Kontakt sieht, hängt von seiner Rolle (Abschnitt 5) ab.
Aufgaben, Meldungen und Freigaben im Portal folgen mit den weiteren
Bereichen.

## Programm & Dokumentation

Diese Bereiche bauen das Programm eines Mandanten auf und halten seine
Dokumentation fest. Was angelegt, geändert oder freigegeben werden darf und
ob eine Angabe vollständig ist, entscheidet das Tax-CMS; TaxTronik zeigt das
Ergebnis an und gibt Personen nur aus der eigenen Datenbank weiter.

### Einrichtung

_Tax-CMS → Einrichtung_ führt in fünf Schritten zu Version 1 des Programms:
**Teilbereich** (Paketvorlage, Abgrenzung, Angemessenheits-Stichtag,
Wirksamkeitszeitraum, Erklärungsturnus), **Geschäftsprofil** (Fragen
P1–P12), **Compliance-Ziele** (Wesentlichkeit, Risikoappetit, optional
Freigabe bei einer gesetzlichen Vertretung), **Risikovorschlag** (übernehmen
oder begründet ablehnen; Kernrisiken bleiben immer aktiv) und
**Kontrollvorschlag** (Partei, durchführende Person, Vertretung,
Gegenzeichnung; Frequenzen aus der Häufigkeitsmatrix).

- Der Entwurf lässt sich jederzeit speichern. „Weiter“ speichert und lässt
  den Schritt vom Tax-CMS prüfen; offene Punkte erscheinen über dem Schritt.
- Vorschläge, Frequenzen und die Prüflast je Monat berechnet das Tax-CMS;
  die Vorschau im Profilschritt dient nur der Orientierung.
- Zur Auswahl stehen in der Kanzlei nur Personen mit Zugriff auf den
  Mandanten, auf Mandantenseite nur Kontakte dieses Mandanten mit Rolle im
  Tax-CMS (Abschnitt 5). Berufsträgerin bzw. Berufsträger und
  Hauptbearbeitung übernimmt TaxTronik aus der Mandantenakte.
- „Tax-CMS Version 1 anlegen“ fragt vorher nach. Danach ist der Assistent
  geschlossen; Änderungen erfolgen in Profil, Risiken und Kontrollen.

### Geschäftsprofil

_Tax-CMS → Profil_ zeigt den zum Stichtag gültigen Profilstand mit den
Änderungen zum Vorgänger, Teilbereich und Ziele, die Historie aller Stände
und den **Risikovorschlag aus dem Profil**: neu vorgeschlagene, begründet
abgelehnte, deaktivierte und nicht mehr vorgeschlagene Risiken.

- **Profil ändern** legt einen neuen Stand mit Gültigkeitsdatum an; frühere
  Stände bleiben unverändert. Optional entstehen die zugehörigen Ereignisse im
  Ereigniseingang.
- **Risiko aufnehmen** legt ein vorgeschlagenes Risiko mit Brutto-Startwerten
  und den fehlenden Katalogkontrollen an. Verantwortlich werden
  Berufsträgerin bzw. Berufsträger und Hauptbearbeitung aus der
  Mandantenakte; sind sie nicht zugeordnet oder dieselbe Person, erscheint ein
  Hinweis statt des Knopfs.

### CMS-Beschreibung

_Tax-CMS → Beschreibung_ gliedert die Beschreibung in Abschnitte mit Freitext
und Bausteinen (Teilbereich, Ziele, Risikoinventar, Kontrollmatrix,
Verantwortung, Länder, Feststellungen), die das Tax-CMS automatisch füllt.

- **Ablauf:** Entwurf → „Zur Kanzlei-Review einreichen“ → „Review
  abschließen“ (eine zweite Person; wer zuletzt bearbeitet hat, bekommt den
  Abschluss nicht angeboten) oder „Zurück in den Entwurf“ mit Begründung
  (mindestens 30 Zeichen) → „Freigabe beim Mandanten anfordern“.
- **Freigabe anfordern** friert den Inhalt ein und bindet ihn mit SHA-256.
  Empfänger ist eine gesetzliche Vertretung dieses Mandanten; sie gibt im
  Mandanten-Portal mit E-Mail-Code frei. Eine offene Anforderung einer
  älteren Version wird dabei zurückgezogen.
- **Eingefrorene Versionen** (beim Mandanten, freigegeben, abgelöst) zeigen
  genau den eingefrorenen Inhalt mit Hash und Prüfergebnis und lassen sich
  nicht bearbeiten; Änderungen entstehen als neue Version. Personen erscheinen
  dort mit dem Namen zum Zeitpunkt des Einfrierens, in lebenden Bausteinen mit
  dem heutigen Namen aus TaxTronik.

### Kommunikation

_Tax-CMS → Kommunikation_ listet Freigaben und Kenntnisnahmen mit Status zum
Stichtag, die Freigabestände von Zielen und Beschreibung sowie Kultur und
Meldewege. **Neu adressieren** richtet eine offene Anforderung an eine andere
Person dieses Mandanten (Freigaben nur an gesetzliche Vertretungen); ein
bereits ausgestellter Code verfällt, die Person erhält eine Nachricht. Der
Schritt fragt vorher nach.

### Katalog

Admins und Partner sehen unter `/staff/tcms/katalog` (Verweis im
Einrichtungsassistenten) den Katalog des Branchenpakets: Risiken, Kontrollen,
Ereignistypen, Häufigkeitsmatrix und Profilfragen – nur lesend und als
**ungeprüfter Entwurf**, den Berufsträgerinnen und Berufsträger kalibrieren.
## Risiken, Kontrollen & Prüfung

Diese Bereiche zeigen, welche Risiken ein Mandant hat, wie er sie mit
Kontrollen steuert und wie eine Prüfung vorbereitet wird. Klassen,
Frequenzen, Status, Fristen und die Zahlen des Wirksamkeitszeitraums
berechnet das Tax-CMS; TaxTronik zeigt sie an, filtert und sortiert. Ob Sie
etwas ändern dürfen und ob eine zweite Person entscheiden muss, prüft das
Tax-CMS bei jedem Schritt.

- **Nur lesen:** An einem früheren Stichtag (Datumsfeld im Kopf) und ohne
  Bearbeitungsrecht laut Tax-CMS sind die Schaltflächen gesperrt; der Grund
  steht über der Liste.
- **Vier-Augen-Prinzip:** Wer eine Übersteuerung oder Frequenzabweichung
  beantragt oder Risiken zur Freigabe eingereicht hat, sieht statt der
  Entscheidung den Hinweis „Von Ihnen beantragt – die Entscheidung trifft
  eine zweite Person.“ Lehnt das Tax-CMS eine Entscheidung ab, erscheint
  „Diese Entscheidung trifft eine zweite Person mit Bearbeitungsrecht für
  diesen Mandanten (Vier-Augen-Prinzip).“
- **Begründungen** brauchen mindestens 30 Zeichen und werden mit Name und
  Zeitpunkt festgehalten. Bei einem Fehler bleiben Ihre Eingaben stehen.

### Risikoinventar

_Tax-CMS → Risiken_ zeigt alle aktiven Risiken als **Liste** oder
**Heatmap** (Schadensintensität × Wahrscheinlichkeit) mit Brutto- und
Nettoklassen (Design und Betrieb), Risikoappetit, Kontrollen, Verantwortlichen
und Freigabestatus. Filter: Gruppe, Governance-Typ, Bruttoklasse, „nur über
Appetit“, „nur übersteuert“, „nur Kernrisiken“ und „nur neu bewerten“; ein
Feld der Heatmap filtert die Liste.

- **Freigabe:** Bewertete Risiken auswählen und „Zur Freigabe einreichen“;
  eingereichte Risiken gibt eine zweite Person frei oder weist sie mit
  Begründung zurück. Übersprungene Risiken nennt die Meldung mit Grund.
- **Detailbereich** (Klick auf ein Risiko): Beschreibung, Normanker,
  Bewertung mit Herleitung über die Kontrollen, Übersteuerungen, Freigabe,
  Risikoappetit, Interdependenzen, Ereignisse, Stand-Historie und Historie.
- **Neu bewerten** legt einen neuen Stand an; geänderte Werte brauchen eine
  erneute Freigabe, und das Tax-CMS plant Durchführungen der verknüpften
  Kontrollen gegebenenfalls neu. **Bewertung bestätigen** hält eine
  unveränderte Bewertung fest.
- **Nettoklasse übersteuern** gilt erst nach Freigabe durch eine zweite
  Person; der berechnete Wert bleibt sichtbar.
- **Risikoakzeptanz anfordern:** Liegt ein Risiko über dem Appetit, fordern
  Sie die Akzeptanz bei einer gesetzlichen Vertretung an (aktiver Kontakt
  dieses Mandanten mit dieser Rolle, Abschnitt 5). Die Freigabe erfolgt im
  Portal mit Bestätigung per E-Mail-Code.

### Kontrollmatrix

_Tax-CMS → Kontrollen_ zeigt die Kontrollen als **Liste** (Risiken,
Frequenz, Zuständige, Design, letzte und nächste Durchführung) oder als
**Matrix** Risiken × Kontrollen. Der Detailbereich enthält Beschreibung,
Frequenzherleitung, Designbeurteilung, Zuständigkeiten, Durchführungen,
Stände und Historie.

- **Frequenzabweichung** beantragen (Turnus, zusätzlich bei jeder
  Auslösung, Begründung); eine zweite Person gibt sie frei oder lehnt sie
  begründet ab. Eine freigegebene Abweichung lässt sich aufheben.
- **Designbeurteilung** „angemessen“ oder „Mangel“ mit Begründung; sie legt
  einen neuen Kontrollstand an.
- **Zuständigkeiten ändern:** Für Kanzleikontrollen stehen Personen mit
  Zugriff auf den Mandanten zur Auswahl, für Mandantenkontrollen Kontakte
  dieses Mandanten mit Rolle im Tax-CMS. Gegenzeichnen kann eine Person der
  Kanzlei oder – bei Mandantenkontrollen – die Vertretung beim Mandanten.
  TaxTronik prüft jede Person beim Speichern erneut.
- Vertrauliche Feststellungen erscheinen nur mit ihrer Nummer.

### Kontrollkalender

_Tax-CMS → Kalender_ zeigt die Durchführungen je Kontrolle und
Fälligkeitsmonat für zwölf Monate; Monate im Wirksamkeitszeitraum sind
hinterlegt, jeder Status hat ein eigenes Symbol (Legende unter der Tabelle).
Filter: Partei und „nur Schlüsselkontrollen“. Darunter steht die Prüflast je
Monat nach Governance-Typ. Ein Symbol öffnet die Durchführung.

### Prüfungsvorbereitung

_Tax-CMS → Prüfung_ fasst zusammen, was eine Prüfung braucht:
Prüfungsgegenstand (Angemessenheit zum Stichtag, Wirksamkeit über den
Zeitraum), **Lückenanalyse** (Zahlen aus dem Tax-CMS; „n. a.“, solange der
Wirksamkeitszeitraum nicht begonnen hat), die sieben Grundelemente, die
freigegebenen Versionen der CMS-Beschreibung mit Hash und die Durchführungen
im Zeitraum. Das Nachweispaket folgt. Ein Prüfurteil trifft das Werkzeug
nicht.

### Länder-Monitor

_Tax-CMS → Länder_ stellt die EU-Fernverkäufe der Lieferschwelle von
10.000 € gegenüber (Warnung ab 80 %) und zeigt je Land Fernverkäufe, Lager,
OSS, lokale USt-Nummer und Registrierungsstatus. Ein Land öffnet
Registrierungsschritte, Fristen, die Historie der Stände und Feststellungen
mit Bezug auf das Land.

- **Daten manuell erfassen** legt für alle Länder auf einmal einen neuen
  Stand an; im Detailbereich geht das je Land. Frühere Stände bleiben in der
  Historie. **Land hinzufügen** nimmt ein weiteres EU-Land auf.
- Beträge in deutscher Schreibweise, z. B. „12.345,67“; „10.000“ bedeutet
  zehntausend. Uneindeutige Schreibweisen wie „1,234.56“ werden abgelehnt.
- Ein neues Lagerland oder ein Wechsel der Schwelle legt das Tax-CMS als
  Ereignis im Ereigniseingang an. Der CSV-Import folgt.
## Ereignisse, Portal-Aufgaben und Audit

Hier triagiert die Kanzlei die Ereignisse ihrer Mandanten. Wer was darf, ob
eine Angabe vollständig ist und was als Nächstes möglich ist, entscheidet das
Tax-CMS; TaxTronik zeigt das Ergebnis an, gibt Personen nur aus der eigenen
Datenbank weiter und liefert Dateien nur über die eigene Dokumentenablage aus.

### Ereigniseingang (Kanzlei)

_Tax-CMS → Ereignisse_ listet alle Meldungen des Mandanten – aus dem Portal,
aus Profiländerungen und von der Kanzlei erfasst („Ereignis erfassen“). Ein
Klick öffnet die Triage:

- **In Prüfung nehmen** zeigt dem Mandanten, dass die Meldung bearbeitet wird.
- **Folgen:** Das Tax-CMS schlägt je Ereignistyp Folgen vor (Risiko neu
  bewerten, außerplanmäßige Kontrolle, Profil ändern, Feststellung anlegen,
  Hinweis). Gewählte Vorschläge werden mit Zuständigkeit und Frist angelegt;
  zur Auswahl stehen Kanzleipersonen mit Zugriff auf den Mandanten und
  Kontakte dieses Mandanten mit Rolle im Tax-CMS. Vorschläge lassen sich
  begründet verwerfen, weitere Folgen vorschlagen.
- **Feststellung anlegen:** Titel, Klasse, Schwere und steuerliche Auswirkung
  werden bewusst gewählt (keine Vorbelegung). „Keine Auswirkung“ ist der
  §-153-Würdigung vorbehalten; ohne dieses Recht legt das Tax-CMS die
  Feststellung mit „unklar“ an und TaxTronik weist darauf hin.
- **Abschließen** geht, wenn jede Folge erledigt oder begründet verworfen und
  mindestens eine erledigt ist; ein Ereignis ganz ohne erledigte Folge wird
  verworfen.
- **Verwerfen** (nur ohne angelegte Folgen) braucht eine Begründung und die
  Bestätigung durch eine **zweite Person**. Wer den Antrag gestellt hat, kann
  ihn nur zurückziehen; andere bestätigen oder lehnen ab.
- **Anlagen** einer Portal-Meldung öffnen Sie aus der Triage. Ausgeliefert
  wird nur der Inhalt, den das Tax-CMS festgehalten hat (SHA-256 und Größe);
  wurde das Dokument in der Ablage ersetzt, erscheint ein Hinweis statt der
  Datei.

### Meldungen in diesen Bereichen

| Meldung                                                               | Bedeutung und was zu tun ist                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Vier-Augen-Prinzip: Diesen Schritt muss eine andere Person ausführen. | Antrag und Bestätigung müssen von verschiedenen Personen kommen.                                     |
| Die Anlage wurde nicht ausgeliefert …                                 | Die Datei in der Ablage weicht vom festgehaltenen Stand ab. Bitte an die Kanzlei bzw. Admins wenden. |

## 7. Meldungen

| Meldung                                               | Bedeutung und was zu tun ist                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Tax-CMS nicht eingerichtet                            | Der Dienst ist nicht angebunden. Bitte an die Administration wenden.                                      |
| Kein Zugriff                                          | Sie haben auf diesen Mandanten oder Bereich keinen Zugriff.                                               |
| Tax-CMS derzeit nicht erreichbar                      | Der Dienst antwortet nicht. Später erneut versuchen; bei Rückfragen die angezeigte Vorgangsnummer nennen. |
| Wurde zwischenzeitlich geändert – bitte neu laden.    | Jemand hat denselben Eintrag gleichzeitig geändert. Seite neu laden und die Änderung erneut vornehmen.    |
| … hat nicht rechtzeitig oder nicht lesbar geantwortet | Ob die Änderung übernommen wurde, ist offen. Seite neu laden und prüfen, bevor Sie sie wiederholen.       |
| Bitte prüfen Sie diese Angabe.                        | Ein Feld wurde vom Tax-CMS oder von TaxTronik abgelehnt (z. B. Person gehört nicht zu diesem Mandanten).  |

## 8. Grenzen

- Das Tax-CMS dokumentiert; es bescheinigt nichts. Eine Aussage über
  Angemessenheit oder Wirksamkeit bleibt einer unabhängigen Prüfung
  vorbehalten.
- Die Regeln zur Weitergabe von Personen und Rechten an das Tax-CMS sind im
  [Fachkatalog](../fachkatalog/README.md) als **ungeprüfte Entwürfe** geführt
  (TCMS-AKTEUR-001, TCMS-DIENST-001); die fachliche Freigabe steht aus.

## 9. Mitteilungen per E-Mail und Hinweis

Das Tax-CMS versendet selbst keine E-Mails. TaxTronik stellt seine
Mitteilungen zu:

- **An Kontakte des Mandanten** per E-Mail: „Freigabe angefordert“,
  „Bestätigungscode“ (nach „Code anfordern“ im Portal) und „Freigabe an Sie
  adressiert“. Die Mails gehen nur an aktive Kontakte genau dieses Mandanten,
  deren Adresse bestätigt ist – der Kontakt hat sich mindestens einmal im
  Mandantenportal angemeldet. Weil es um eine Freigabe geht, die der Kontakt
  selbst angefordert hat oder die ihn nennt, gelten sie unabhängig von
  „Benachrichtigungen per E-Mail“ des Kontakts. Der Code steht nie im
  Betreff und gilt höchstens 7 Tage.
- **An Kanzleipersonen** als Hinweis in TaxTronik: „Ereignis im Tax-CMS
  gemeldet“ mit Nummer und Titel, nur an die zuständige Person mit Zugriff
  auf den Mandanten. Der Hinweis führt zu den Ereignissen des Mandanten.

**Texte anpassen:** Unter _Administration → E-Mail-Vorlagen_ stehen die
System-Vorlagen „Tax-CMS: Freigabe angefordert“, „Tax-CMS: Bestätigungscode“
und „Tax-CMS: Freigabe neu adressiert“ mit ihren Platzhaltern. Hat Ihre
Kanzlei keine eigene Fassung, nennt die Seite sie unter „System-Vorlagen mit
Standardtext“; es gilt dann der Standardtext.

**Nicht zugestellt?** Kann TaxTronik einen Empfänger nicht bestätigen (z. B.
Kontakt ohne Portal-Anmeldung, deaktiviert, anderem Mandanten zugeordnet;
Kanzleiperson ohne Zugriff), erhalten Admins und Partner einmal je Mitteilung
den Hinweis „Mitteilung des Tax-CMS nicht zugestellt“ mit dem Grund – ohne
Inhalt und ohne Code. Nach der Korrektur stellt TaxTronik innerhalb einer
Minute zu. Nach 7 Tagen ohne Korrektur oder nach Ablauf des Codes gilt die
Mitteilung als unzustellbar; fordern Sie die Freigabe dann im Tax-CMS neu an
oder adressieren Sie sie neu. Mails des Tax-CMS können nicht über „Erneut
senden“ wiederholt werden.

## Durchführungen, Feststellungen und Arbeitskorb

### Durchführungen

_Tax-CMS → Durchführungen_ listet die Kontrolldurchführungen des Mandanten mit
Periode, Fälligkeit, Status, Nachweisen und Zuständigkeit. Filter: offen, zur
Gegenzeichnung, geplant, abgeschlossen, entfallen oder alle; Kanzlei oder
Mandant; nur Schlüsselkontrollen. Ein Klick öffnet die Durchführung.

In der Durchführung arbeiten Sie die Schritte ab, erfassen Werte (Beträge im
Format 1.234,56; Differenzen und Toleranz zeigt die Seite sofort an), hängen
Nachweise an und wählen das Ergebnis. „Entwurf speichern“ sichert den Stand;
„Zur Gegenzeichnung einreichen“ speichert und reicht ein. Fehlt noch etwas,
bleibt der Entwurf gespeichert und die Meldung nennt die offenen Punkte. Eine
zweite Person zeichnet gegen oder weist mit Begründung zurück; bei einem
Befund wird dabei die Feststellung erfasst. Wer durchgeführt hat, kann nicht
selbst gegenzeichnen. Entfallen beantragen (mit Begründung) gibt eine zweite
Person frei; abgeschlossene Durchführungen ändern Sie nur über einen
Nachtrag. Welche Schaltflächen Sie nutzen können, entscheidet das Tax-CMS;
gesperrte zeigen den Grund. Ein früherer Stichtag zeigt nur an.

### Nachweise

- **Hochladen:** Die Datei wird in der Dokumentablage des Mandanten
  gespeichert (Virenscan, Prüfsumme, Typ „Allgemein“) und dann als Nachweis
  angehängt; das Tax-CMS erhält nur einen Verweis. Gleicher Inhalt wird nicht
  doppelt angehängt. Lehnt das Tax-CMS das Anhängen ab, bleibt die Datei in
  der Ablage; die Meldung sagt das.
- **Vorhandenes Dokument wählen:** Zur Auswahl stehen gescannte Dokumente
  dieses Mandanten ohne GwG-, Personal- oder Lohnbezug.
- **Herunterladen:** über die Dokumentablage mit Ihren Rechten in TaxTronik.
  Stimmt die gespeicherte Datei nicht mehr mit dem Nachweis überein, wird sie
  nicht ausgeliefert („Abweichung zur Ablage – nicht abrufbar“).
- **Schutz:** Solange ein Dokument als Nachweis verknüpft ist, lässt es sich
  in der Ablage nicht löschen und keine neue Version hochladen. Entfernen Sie
  zuerst den Nachweis in der Durchführung (nur vor dem Einreichen möglich).

### Feststellungen und Maßnahmen

_Tax-CMS → Feststellungen_ listet die Feststellungen mit Quelle, Klasse,
Schwere, steuerlicher Auswirkung, §-153-Stand, offenen Maßnahmen und ältester
Frist, darunter alle offenen Maßnahmen. In der Feststellung bearbeiten Sie
Würdigung, betroffene Erklärungen, Maßnahmen (Verantwortliche: Personen der
Kanzlei mit Zugriff auf den Mandanten oder Kontakte des Mandanten mit
Tax-CMS-Rolle), Nachkontrolle und schalten den Status weiter.

- **§-153-Würdigung:** vier gleichrangige Optionen ohne Vorauswahl,
  Begründung mit mindestens 30 Zeichen, Frist bei „Berichtigung erforderlich“
  und „Weitere Klärung“. Würdigen dürfen nur zuständige Berufsträgerinnen und
  Berufsträger.
- **Verwerfen:** mit Begründung beantragen; eine zweite Person bestätigt.
- **Vertraulich:** markiert die zuständige Berufsträgerin bzw. der zuständige
  Berufsträger; Nicht-Beteiligte sehen dann nur „<Nummer> · Vertrauliche
  Feststellung“.

### Arbeitskorb

Der Arbeitskorb des Tax-CMS (Adresse `/staff/tcms/arbeitskorb`) sammelt Ihre offenen
Aufgaben über alle Mandanten: eigene Durchführungen, Gegenzeichnungen,
Vier-Augen-Bestätigungen, §-153-Würdigungen, neue Ereignisse und
Beschreibungen im Kanzlei-Review. Ein Klick führt in den Bereich des
Mandanten.

| Meldung                                                             | Bedeutung und was zu tun ist                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Entwurf gespeichert, aber noch nicht eingereicht: …                 | Die genannten Punkte fehlen noch. Ergänzen und erneut einreichen.                                  |
| … in der Dokumentablage gespeichert, aber nicht als Nachweis …      | Die Datei liegt in der Ablage; als Nachweis später über „Vorhandenes Dokument“ erneut anhängen.    |
| Dieses Dokument ist als Nachweis … verknüpft                        | Erst den Nachweis in der Durchführung entfernen, dann löschen bzw. eine neue Version hochladen.    |
| Der Schritt ist noch nicht möglich oder … zwischenzeitlich geändert | Voraussetzungen des nächsten Schritts prüfen (Anzeige „Nächster Schritt“) und die Seite neu laden. |
