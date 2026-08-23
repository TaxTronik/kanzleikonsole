# Workflows, Anforderungen und Formulare

Workflows strukturieren kanzleiinterne und mandantengerichtete Abläufe. Das
Workflow- und das Formularmodul sind getrennt tenantweise aktivierbar; der
jeweils deaktivierte Funktionsbereich ist auch über direkte URLs und
Server-Actions nicht nutzbar. n8n ist eine optionale Integrations- und
Kommunikationsschicht, nicht die Quelle für fachlich zwingende Kernkontrollen.

## 1. Workflow-Vorlagen

Unter **Workflows → Vorlagen** verwalten berechtigte Mitarbeiter wiederholbare
Abläufe. Eine Vorlage enthält geordnete Schritte, zum Beispiel:

- interne Aufgabe,
- Dokument-Upload,
- Mandantenanforderung,
- Mandantenformular,
- E-Mail,
- gesicherten n8n-Trigger.

Vorlagen mit bestehenden Instanzen werden nicht rückwirkend still umgebaut.
Nicht mehr benötigte Vorlagen sollten deaktiviert statt gelöscht werden.

## 2. Instanzen und Ausführung

Eine Instanz wird im Mandantenprofil gestartet und ist zusätzlich in der
globalen Workflow-Übersicht sichtbar. Schritte dürfen nur einmal fachlich
beansprucht werden; Doppelklicks oder parallele Browserfenster erzeugen keine
zweiten Anforderungen/Formulare. Bei einem technischen Fehler bleibt ein
wiederholbarer Zustand sichtbar.

Mitglieder, Bearbeiter und Übergabe-Empfänger müssen den Mandanten nach der
konfigurierten Zugriffspolicy öffnen dürfen. Im Modus **Offen** können Aufgaben
spontan jedem aktiven Kanzleimitarbeiter übertragen werden; **Eingeschränkt**
und das Vertraulich-Flag begrenzen auf Admin/Partner und zuständige
Mitarbeiter. Diese Grenze gilt auch bei nachträglicher Zuweisung.

E-Mail-Schritte führen den Versandstatus je Empfänger. Ein Retry überspringt
Kontakte, deren erfolgreiche SMTP-Übergabe bereits dauerhaft als versandt
gespeichert ist. Im Ausfallfenster zwischen SMTP-Annahme und dieser
Statusspeicherung ist eine Doppelzustellung möglich. Die SMTP-Annahme ist keine
Bestätigung der endgültigen Zustellung. Ein n8n-Trigger gilt erst als
abgeschlossen, wenn sein Outbox-Ereignis dauerhaft gespeichert **und einer
zustellbaren Route übergeben** wurde. `UNROUTED`, `SKIPPED` und technische
Schreibfehler lassen den Workflow-Schritt offen.

## 3. Anforderungen und Kommentare

Mandantenanforderungen erscheinen im Portal, solange eine Antwort benötigt
wird. Textantwort, Dokumentantwort oder verknüpfte Formularabgabe setzen den
mandantenseitigen Vorgang auf **Beantwortet**. Damit enden Portalhinweise und
Überfälligkeits-Erinnerungen für die offene Antwort.

Der Status **Beantwortet** beendet nicht die interne Zusammenarbeit:
Kanzleimitarbeiter können danach weiterhin Kommentare, Prüfhinweise und
Nacharbeiten erfassen. Ein bewusster interner Abschluss setzt den Vorgang auf
**Geschlossen** und beendet den Statusablauf sowie die mandantenseitige
Kommunikation. Kanzleiinterne Kommentare und spätere Nachträge bleiben auch bei
**Geschlossen** oder **Storniert** möglich und werden nicht automatisch an den
Mandanten veröffentlicht.

Beantwortete oder geschlossene Anforderungen können Mitarbeiter in der
Detailansicht über **Anforderung wieder öffnen** auditierbar auf **Offen**
zurücksetzen. Stornierte Anforderungen bleiben terminal. Ein noch nicht
abgesendetes verknüpftes Formular wird dann wieder freigegeben. Bereits
übermittelte oder geprüfte Formulare bleiben unveränderlich.

## 4. Formularvorlagen und Versand

Unter **Formular-Vorlagen** erstellt die Kanzlei strukturierte Formulare mit
Pflicht-/Optionalfeldern, Auswahlfeldern, Hinweisen und Datei-Feldern. Nur
aktive Vorlagen können neu versandt werden. Im Mandantenprofil wird eine
Submission erzeugt und mit der zugehörigen Anforderung verknüpft.

Mandanten sehen offene Formulare unter **Formulare**. Draft und Abgabe prüfen
serverseitig Feldtyp, Format, Zahlen-/Datumsgrenzen, freigegebene Optionen und
Dateireferenzen; beim Absenden zusätzlich sämtliche Pflichtfelder. Sobald die
zugehörige Anforderung beantwortet, geschlossen oder storniert ist, sind Draft,
Abgabe und weitere Datei-Uploads gesperrt. Eine bereits übermittelte Submission
kann nicht ein zweites Mal denselben fachlichen Abschluss auslösen. Datei-Felder
unterliegen einem Größenlimit, einer Magic-Byte-Typerkennung und dem
Virenscan. Einen hochgeladenen Beleg
kann der Mandant im Wizard vor der Abgabe wieder verwerfen; nach Abgabe oder
Sperre der zugehörigen Anforderung ist das nicht mehr möglich.

## 5. Fehlerbehandlung

- Eine Fehlermeldung nicht durch wiederholtes schnelles Klicken umgehen.
- Bei „läuft bereits" den aktuellen Status neu laden.
- Bei E-Mail-Teilfehlern nur die als offen ausgewiesenen Empfänger erneut
  zustellen lassen.
- n8n-Ausfälle über die Integrations-/Outbox-Ansicht bearbeiten; ein als offen
  angezeigter Trigger wurde nicht als Erfolg verbucht.
