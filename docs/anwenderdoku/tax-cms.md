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
