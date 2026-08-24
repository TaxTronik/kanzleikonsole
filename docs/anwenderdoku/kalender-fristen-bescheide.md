# Kalender, Steuerfristen und Bescheide

Das Modul bündelt Kanzleitermine, gesetzliche Steuertermine und
Bescheidfristen. Automatisch berechnete Fristen sind Kontrollvorschläge und
müssen bei abweichender Bekanntgabe oder besonderen Rechtsbehelfsregeln
fachlich geprüft werden.

## 1. Kanzleikalender und Terminanfragen

Unter **Kalender** werden Kanzleitermine, Steuertermine und weitere
fristenführende Einträge in einer Monatsansicht zusammengeführt. Die fokussierte
Ansicht **Steuertermine** gruppiert nach Steuerart und Zeitraum.

Portalnutzer sehen bestätigte eigene Termine. Neue Wunschtermine können sie nur
anfragen, wenn das Portal-Feature **Terminanfragen** aktiviert ist. Eine Anfrage
ist noch kein bestätigter Termin; die Kanzlei nimmt sie an, ändert oder lehnt
sie ab. Als Wunsch-Bearbeiter werden im offenen Zugriffsmodus alle aktiven
Mitarbeiter angeboten. Im eingeschränkten Modus und bei vertraulichen Mandanten
beschränkt sich die Auswahl auf Admin/Partner und zuständige Mitarbeiter; die
gleiche Prüfung erfolgt nochmals serverseitig.

## 2. Steuertermine und Auto-Anforderungen

Der Worker materialisiert Termine aus der aktiven Kanzleikonfiguration. Vor
einer automatischen Mandantenanforderung erscheint eine interne Vorwarnung; die
Kanzlei kann den Lauf stoppen, wenn Unterlagen bereits vorliegen. Erzeugung und
Verknüpfung sind idempotent: parallele Worker-/Webläufe dürfen nur eine
Anforderung erzeugen. Die Vorwarnung geht an alle aktiven Hauptbearbeiter;
fehlt die aktive Hauptbearbeitung vollständig, werden alle aktiven Admins und
Partner verwendet. Fehlt auch dort ein aktiver interner Empfänger, wird die
Vorwarnung nicht als zugestellt gestempelt.

Portal-Anforderung und Benachrichtigung werden getrennt geführt. Zusammen mit
der Request-Verknüpfung wird atomar `QUEUED` gespeichert. Danach verarbeitet
der Worker immer denselben Request. Als Empfänger fachlicher
Mandantenbenachrichtigungen berücksichtigt er nur aktive Kontakte mit
Benachrichtigungsfreigabe und einem bereits gespeicherten erfolgreichen
Portal-Login. Ein bloß eingeladener, noch nie erfolgreich angemeldeter Kontakt
erhält auf diesem Weg keine fachliche Benachrichtigung; der Einladungsversand
ist davon getrennt. Nach Änderung der Kontakt-E-Mail muss ein neuer
erfolgreicher Portal-Login vorliegen. Externer Versand erfolgt nur für Requests
in `OPEN` oder `IN_PROGRESS`; bereits beantwortete, geschlossene oder
abgebrochene Requests werden ohne Versand aus der technischen Pipeline gelöst.
Die automatische Anforderung verwendet einen eigenen datenminimierten
Mail-Template-Scope: Mandantenname, Steuerart, Zeitraum, Fälligkeit, Titel und
Beschreibung bleiben im geschützten Portal und stehen dem Mail-Template weder
als Variablen noch als Betreff-Suffix zur Verfügung. Ein optionales
n8n-Ereignis wird je Anforderung einmalig, nicht je Kontakt und auch dann
ausgelöst, wenn kein aktiver Mailkontakt existiert; der Mailstatus bleibt in
diesem Fall `NO_RECIPIENT`.

- `PROVIDER_ACCEPTED` bedeutet nur, dass alle Einzelversuche technisch vom
  konfigurierten Dispatcher angenommen wurden. Das ist kein Nachweis für
  Zustellung, Zugang oder Kenntnisnahme.
- Scheitern alle Einzelversuche durch ausdrückliche negative
  SMTP-Providerantworten eindeutig, wird derselbe Vorgang höchstens dreimal
  versucht und anschließend intern eskaliert. Transport-, Socket- und
  Timeout-Exceptions gelten wegen einer nicht sicher auszuschließenden
  Providerannahme als `UNKNOWN` und werden nicht automatisch wiederholt.
- Bei Teilannahme, fehlendem Empfänger oder unklarem Ausgang erfolgt keine
  blinde Wiederholung, sondern eine interne Eskalation. Das vermeidet
  Doppelversand, verlangt aber eine manuelle Prüfung.
- Wird die Request-Verknüpfung regulär entfernt, bleibt die technische Historie
  als `ORPHANED` erhalten, ist danach datenbankseitig unveränderlich und der
  Worker sendet nicht erneut. Nur eine Löschung im ausdrücklich vorgesehenen,
  transaktionslokal freigegebenen DSGVO-Purge neutralisiert alle technischen
  Metadaten auf `NOT_REQUIRED`.
- Wird ein Steuertermin mit einer bereits terminalen Anforderung regulär
  gelöscht, bleibt höchstens ein pseudonymer technischer Hilfsnachweis ohne
  Fehlerklartext zurück. Er ist für die Anwendung nicht lesbar und wird
  tenantgebunden spätestens nach einem Jahr gelöscht.
- Während ein persistierter `UNKNOWN`-Versandversuch möglicherweise noch läuft,
  blockiert die Datenbank sowohl das reguläre Entfernen als auch den
  DSGVO-Purge. Erst nach gespeichertem Versandabschluss oder
  Timeout-Eskalation kann die Verknüpfung bearbeitet werden.

Eine interne Eskalation garantiert nicht, dass ein Mitarbeiter sie rechtzeitig
bearbeitet. Empfängerzuordnung und Benachrichtigungsstatus müssen daher in der
Kanzleiorganisation überwacht werden. Der frühere Portal-Login bestätigt die
aktuelle E-Mail-Adresse nicht bei jedem Versand erneut und ersetzt keine
fachliche Empfängerprüfung.

Am Fälligkeitstag bleibt ein Termin bis zum Tagesende offen. Erst danach wird
er überfällig. Das konfigurierte Bundesland ist nur der technische
Standardkalender. Anwendbarkeit des § 108 Abs. 3 bis 6 AO, rechtlich
maßgeblicher Feiertagsort sowie historische, kommunale und ausländische
Besonderheiten müssen bei Steuerterminen bei Bedarf gesondert geprüft werden.
Der Bescheidpfad erfasst Empfängerort und Behördensitz dagegen getrennt und
kennzeichnet einen unvollständigen Kalenderkontext als manuell zu prüfen.

## 3. Bescheid erfassen

Im Mandantenprofil unter **Bescheide & Steuererklärungen** werden Steuerart,
Zeitraum, Übermittlungsweg und die dafür angebotenen Datumsangaben erfasst.
Dokumentieren Sie dabei Ausgangsbasis, Nachweisstatus, Zugangslage,
Rechtsbehelfsbelehrung sowie Empfänger- und Behördenort vollständig:

- Bei Post und unmittelbarer elektronischer Übermittlung ist dort der
  tatsächliche Aufgabe- beziehungsweise Absendetag einzutragen.
- Beim Datenabruf ist es der tatsächliche Bereitstellungstag.
- Bei der Basis **fachlich festgestellter tatsächlicher Zugang** müssen
  Ausgangsdatum und Zugangstag denselben festgestellten Bekanntgabetag
  bezeichnen; abweichende Eingaben werden abgewiesen.
- Ist ein Aufgabe- oder Absendetag unbekannt, wählen Sie ausdrücklich
  **Bescheiddatum – nur interner Risikotermin**. Bekanntgabetag und gesetzliche
  Einspruchsfrist bleiben dann leer; der getrennte Risikotermin stellt keine
  rechtliche Feststellung dar.

Der Übermittlungsweg ist entscheidend:

- Post beziehungsweise elektronische Übermittlung im Inland,
- Post ins Ausland,
- Datenabruf,
- förmliche, persönliche oder sonst nachgewiesene Bekanntgabe.

Für bis einschließlich 31.12.2025 erlassene Verwaltungsakte im Datenabruf
werden Benachrichtigungsdatum und gegebenenfalls tatsächlicher Abruf benötigt.
Für 2026 wird die Vier-Tage-Berechnung nur angeboten, wenn die aktive
Einwilligung dokumentiert ist. Ab 2027 müssen die Voraussetzungen für den
Abrufweg und ein etwaiger wirksamer Postantrag getrennt bewertet werden. Ein
behaupteter oder unbekannter Bereitstellungstag reicht nicht; die Bereitstellung
muss mindestens substantiiert sein.

Bei einem als wirksam erfassten Postantrag ist dessen Zugangstag erforderlich.
Ist der Antrag spätestens am Bereitstellungstag bei der Finanzbehörde
zugegangen, blockiert die Software die automatische Feststellung und verlangt
eine fachliche Prüfung der tatsächlichen Bekanntgabe und einer möglichen
Wiedereinsetzung. Ein erst nach dem Bereitstellungstag zugegangener Antrag
blockiert diese bereits frühere Bereitstellung nicht allein deshalb; seine
Wirkung auf spätere Verwaltungsakte ist gesondert zu prüfen.

Für das Neurecht erfassen Sie außerdem Ergebnis und Datum der
Same-Day-Benachrichtigung. Ein Fehler oder verspäteter Versand verschiebt den
Fiktionstag nicht automatisch, erzeugt aber einen sichtbaren
Wiedereinsetzungs-Prüfhinweis. „Nicht zugegangen“ besitzt derzeit keinen eigenen
UI-Status und muss als unklarer Sachverhalt zusätzlich dokumentiert werden. Der
Hinweis ist noch kein vollständiger §-110-Workflow.

Die Feiertagsprüfung verwendet einen eigenen Kontext für den Empfängerort und
einen weiteren für den Behördensitz. Ein bestätigter deutscher Kontext verlangt
Bundesland, Ort/Gemeinde, dokumentierte Kalenderquelle und in Bayern eine
ausdrückliche Angabe zu Mariä Himmelfahrt; zusätzliche örtliche Feiertage
können vorgangsbezogen eingetragen werden. Historisch ungeprüfte,
landesweit unvollständige oder ausländische Kalender führen zur manuellen
Prüfung.

Ein früher tatsächlich dokumentierter Zugang wird getrennt erfasst und
verkürzt die gesetzliche Bekanntgabefiktion nicht. Ein behaupteter Nichtzugang
oder späterer Zugang blockiert die automatische Fristfeststellung. Beim nur
behaupteten späteren Zugang zeigt die Anwendung gleichzeitig den Kontrolltermin
aus der gesetzlichen Fiktion und einen Vergleichstermin aus dem behaupteten
Zugang. Keiner der beiden Werte ist dann eine festgestellte Rechtsfrist.

Ein abweichender Zugangstag wird nur mit der Eingabe **fachlich festgestellt**
als rechtlicher Ausgangstag übernommen. Gleiches gilt für besondere
Bekanntgabewege. Die Software erzwingt jedoch weder einen verknüpften
unveränderbaren Beleg noch eine unabhängige Berufsträger-/Vier-Augen-Freigabe;
jeder für das Modul berechtigte Mitarbeiter kann diese Einstufung auswählen.
Verwenden Sie sie daher nur nach der kanzleiintern vorgesehenen fachlichen
Prüfung. Bei fehlender oder unwirksamer Rechtsbehelfsbelehrung schlägt die
Software grundsätzlich eine Jahresfrist vor; bei **unklar** bleibt die
Fristberechnung gesperrt.

Im Mandantenportal wird das erfasste Datum entsprechend seiner Basis als
Aufgabe-/Übermittlungstag, Bereitstellungstag, fachlich festgestellter
Zugangstag oder bloße Risikobasis bezeichnet. Ein Frist-Kontrollvorschlag wird
dort nur angezeigt, wenn die Berechnung den Status `CALCULATED` trägt und kein
manueller Prüfbedarf mehr gespeichert ist.

Auch der tägliche Einspruchsfristen-Reminder verwendet ausschließlich solche
vollständig berechneten Vorschläge ohne offenen manuellen Prüfbedarf. 14, 7 und
1 Tag vor Fristende wird zunächst die dokumentierte prüfende Person verwendet,
aber nur, wenn sie weiterhin aktiv ist und aktuell auf den Mandanten zugreifen
darf. Andernfalls geht die interne Notification an alle aktiven
Hauptbearbeiter, ersatzweise an aktive Admins und Partner. Gibt es kein
berechtigtes Ziel, entsteht keine globale Notification. Fristqualifikation und
Mandantenzugriff werden unmittelbar vor dem Eintrag nochmals in derselben
Tenant-Transaktion geprüft.

Entsprechend erzeugen erledigte oder inzwischen neu zugewiesene
Wiedervorlagen keine veraltete Fälligkeitsmeldung. Bei Pendelordnern werden der
weiterhin offene Status, das Rückgabedatum und der aktuelle Ersteller erneut
geprüft. Mandantenbezogene Meldungen gehen nur an aktive, aktuell
zugriffsberechtigte Personen; bei internen Wiedervorlagen muss der Empfänger
weiterhin aktiver Mitarbeiter des Tenants sein.

## 4. Rechtsbehelfsstatus

Der derzeit technisch abgebildete Lebenszyklus lautet:

`NEU → GEPRÜFT → EINSPRUCH → ABGEHOLFEN / TEILABHILFE /
TEIL-EINSPRUCHSENTSCHEIDUNG / ZURÜCKGEWIESEN → KLAGE oder
BESTANDSKRÄFTIG`.

Wesentliche Übergänge verlangen den tatsächlichen Ereignistag und speichern die
handelnde Person. Bei `TEILABHILFE` sind dies der tatsächliche Bekanntgabetag
des Änderungs-/Teilabhilfebescheids und die Person, die ihn dokumentiert hat.
Der Tag darf nicht vor der dokumentierten Einspruchseinlegung liegen; beide
Angaben bleiben auch bei einem späteren Verfahrensstatus erhalten. Abhilfe,
Einspruchsentscheidung, Klageeinreichung und Bestandskraft dürfen nicht vor
diesem Teilabhilfetag dokumentiert werden. Die
Teilabhilfe lässt den Einspruch fortdauern und erzeugt allein keine Klagefrist. Erst
`TEILEINSPRUCHSENTSCHEIDUNG` oder `ZURUECKGEWIESEN` kann aus dem dokumentierten
Bekanntgabetag der Entscheidung eine Klagefrist eröffnen. `KLAGE` verlangt den
Einreichungstag; `BESTANDSKRAEFTIG` verlangt einen bewusst dokumentierten
Ereignistag sowie eine Begründung von mindestens zehn Zeichen und kann nur von
Admin oder Partner gesetzt werden. Aus `GEPRUEFT` lässt die Software den
Abschluss nur zu, wenn die Einspruchsfrist vollständig berechnet ist, kein
manueller Prüfbedarf besteht, die Frist abgelaufen und kein Einspruch
dokumentiert ist. Der Fristtag selbst ist gesperrt; der Abschluss ist technisch
frühestens am Folgetag möglich. Aus `ZURUECKGEWIESEN` gilt dasselbe für die
dokumentierte Klagefrist. Für die zugelassenen Übergänge aus `ABGEHOLFEN` und
`KLAGE` gelten diese besonderen Frist-Gates derzeit nicht. Die
Rollenbeschränkung ist keine Prüfung der Berufsträgerqualifikation und ersetzt
kein Vier-Augen-Prinzip.

Bei migrierten Teilabhilfen können diese beiden eindeutig bezeichneten
Nachweisfelder im Altbestand fehlen. Die Migration erfindet weder Tag noch
Person und erhält den historischen Status. Beim nächsten Statusfortschritt
verlangt die Maske den tatsächlichen Bekanntgabetag aus der Verfahrensakte; als
dokumentierende Person wird der aktuell bestätigende Mitarbeiter gespeichert.

Das Verfahren bleibt trotzdem technisch **linear**. Eine
Teil-Einspruchsentscheidung kann für den entschiedenen Teil eine Klagefrist
eröffnen, während der Einspruch über den übrigen Teil weiterläuft. Der einzelne
Bescheidstatus kann diese parallelen, gegenständlich abgegrenzten Zweige nicht
vollständig darstellen. Führen Sie Teilgegenstände und parallele Fristen bis zu
einer Modellerweiterung zusätzlich in der kanzleiinternen Dokumentation.

## 5. Fristenkontrollbuch und Kontrollpflicht

Prüfen Sie insbesondere tatsächlichen späteren Zugang, Bundesland/Feiertage,
Auslandsfälle, Rechtsbehelfsbelehrung und nachträglich erfasste Altbescheide.
TaxTronik ersetzt keine rechtliche Einzelfallprüfung und keine
Fristenkontrollorganisation der Kanzlei.

Das zentrale Fristenkontrollbuch besitzt keinen eigenen Erledigt-Schalter,
sondern leitet die aktuelle Sicht aus den Fachmodulen ab. Das vermeidet eine
zweite manuelle Statuspflege, garantiert aber nicht automatisch die fachliche
Richtigkeit jedes Quellstatus. Die aktuelle Ableitung schließt:

- Steuertermine nur mit `DONE`, Abschlusszeit und Person,
- Einspruchs- und Klagefristen nur mit dokumentierter Einlegung oder einer
  Bestandskraft-Disposition samt Zeit, Person und Begründung,
- Anforderungen nur mit `CLOSED`, Abschlusszeit und Person sowie
- Wiedervorlagen nur mit dokumentiertem Abschluss.

Kann die Anwendung wegen ungeklärter Bekanntgabe oder Nachweise keine
Einspruchsfrist berechnen, verschwindet ein vorhandener interner Risikotermin
nicht: Er erscheint in Ansicht, CSV und Tagesabschluss als **Interner
Prüftermin – keine Rechtsbehelfsfrist** und bleibt bis zu einer echten
Fristberechnung offen. Ein eigener strukturierter Abschlussgrund „nicht
anwendbar“ ist für diesen Prüffall derzeit nicht vorhanden.

`SKIPPED`, `RESPONDED` und `CANCELLED` bleiben mangels vollständig
strukturierter Abschlussgründe offen. Zeit und Person sind noch kein
verknüpfter Versand-, Eingangs- oder sonstiger Beleg. Eine erst nach Fristende
dokumentierte Einspruchs- oder Klageeinlegung bleibt als
Wiedereinsetzungs-/Dispositionsfall ebenfalls offen. Ein eigener strukturierter
Wiedereinsetzungsworkflow ist derzeit nicht vorhanden; die fachliche Behandlung
muss außerhalb dieses Statusmodells nachvollziehbar dokumentiert werden.
Eine bereits nach einer Teil-Einspruchsentscheidung dokumentierte Klagefrist
bleibt auch bei einem späteren Status **Abgeholfen** in der Kontrollsicht, bis
eine fristwahrende Einreichung oder vollständige Abschlussdisposition
nachgewiesen ist.

Der CSV-Export ist ein auditierter Kontrollauszug, aber kein Beweis der
fristwahrenden Handlung.

Admin oder Partner können unter **Fristen** einmal pro Kalendertag einen
tenantweiten Tagesabschluss dokumentieren. Er enthält alle zum Zeitpunkt der
Ausführung heute fälligen und überfälligen offenen Fristen. Sobald solche
Positionen vorhanden sind, ist eine Eskalationsnotiz Pflicht. Der Snapshot ist
im App-Datenbankzugriff append-only und wird zusätzlich auditiert. Die
Quellabfragen und das Speichern laufen mit demselben konsistenten Datenstand;
Stichtag, Snapshot- und Abschlusszeit setzt die Datenbank. Pro Position werden
nur Quelle, technische Kontrollart (berechneter Vorschlag, offener Prüfvorschlag,
interner Risikotermin oder operatives Fälligkeitsdatum), Fälligkeit und
pseudonyme UUID-Verweise gespeichert, keine Namen oder fachlichen Klartexttitel.
Die UUIDs und die freie Eskalationsnotiz bleiben
gleichwohl datenschutz- und aufbewahrungsrelevant; vermeiden Sie unnötige
Personendaten im Notizfeld.

Der Tagesabschluss verändert keine Quellvorgänge, versendet keine Eskalation
und prüft keine Belegdatei. Er läuft nicht automatisch zu einer festen Uhrzeit
und erzwingt keine Vertretungs- oder Vier-Augen-Kontrolle. Die Kanzlei muss
Arbeitsschluss, Nachweisprüfung, Vertretung und Bearbeitung der Eskalation daher
weiterhin organisatorisch festlegen.
