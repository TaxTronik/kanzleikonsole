---
id: TAX-NOTICE-APPEAL-001
title: Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen
domain: fristen-und-bescheide
rule_type: professional_interpretation
jurisdiction: DE
validity:
  valid_from: '2025-01-01'
  valid_until: null
professional_owner_role: Berufsträger Steuerrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Bekanntgabeweg, Drei-/Vier-Tage-Cutover, getrennte Feiertagsorte,
    Zugangseinwendungen mit Vergleichsszenarien, Risikotermin, dreistufige
    Belehrungsprüfung und begründete Abschluss-Gates sind beweisorientiert
    umgesetzt. Es fehlen eine unabhängige fachliche Freigabe, beleggebundene
    Nachweise und ein verzweigtes Modell für Teilentscheidungen.
sources:
  - kind: official_law
    citation: § 122 Abs. 1, 2, 2a und 5 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__122.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: Art. 97 § 1 Abs. 15 EGAO
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__1.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 355 Abs. 1 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__355.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 356 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__356.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 108 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 187 BGB
    url: https://www.gesetze-im-internet.de/bgb/__187.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 188 BGB
    url: https://www.gesetze-im-internet.de/bgb/__188.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 122a AO als Abgrenzung
    url: https://www.gesetze-im-internet.de/ao_1977/__122a.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: Art. 97 § 28 EGAO als Abgrenzung
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__28.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: BMF-Schreiben vom 13.08.2026 zur Bekanntgabe durch Bereitstellung zum Datenabruf
    url: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/2026-08-13-bekanntgabe-von-steuerverwaltungsakten.pdf?__blob=publicationFile&v=4
    checked_at: '2026-08-23'
    primary: false
  - kind: case_law
    citation: BFH, Beschluss vom 26.01.2010 – X B 147/09
    url: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE201050203/
    checked_at: '2026-08-23'
    primary: false
  - kind: case_law
    citation: BFH, Beschluss vom 26.02.2021 – X B 108/20
    url: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE202150085/
    checked_at: '2026-08-23'
    primary: false
  - kind: case_law
    citation: BFH, Urteil vom 29.07.2025 – VI R 6/23
    url: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE202520315/
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/db/prisma/schema.prisma
  - packages/tax/src/engine.ts
  - packages/tax/src/index.ts
  - packages/tax/src/legal-assessments.ts
  - apps/web/src/app/portal/(protected)/steuer/page.tsx
  - apps/web/src/app/portal/(protected)/steuer/notice-visibility.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/status-select.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-assessment.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-audit.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-transition.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/transitions.ts
  - apps/worker/src/jobs/reminders-daily.ts
  - packages/db/prisma/migrations/20260823200000_tax_notice_status_terms/migration.sql
  - packages/db/prisma/migrations/20260823201000_tax_professional_control_model/migration.sql
test_refs:
  - packages/db/src/__tests__/tax-notice-evidence.test.ts
  - packages/db/src/__tests__/tax-notice-partial-relief-migration.test.ts
  - packages/tax/src/__tests__/legal-assessments.test.ts
  - packages/tax/src/__tests__/plausibility-engine.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-assessment.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-audit.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-transition.test.ts
  - apps/web/src/app/portal/(protected)/steuer/__tests__/notice-visibility.test.ts
  - apps/worker/src/jobs/__tests__/reminders-daily.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-DEADLINE-WORKDAY-001
  - TAX-CONTROL-STATUS-001
  - TAX-NOTICE-DATARETRIEVAL-001
tags:
  - bescheid
  - bekanntgabe
  - einspruch
---

# TAX-NOTICE-APPEAL-001 — Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen

## Kurzfassung

TaxTronik ermittelt in klar dokumentierten Standardfällen zunächst den
rechtlichen Bekanntgabetag und berechnet daran anschließend grundsätzlich die
einmonatige Einspruchsfrist nach § 355 Abs. 1 AO. Bei unterbliebener oder
unrichtiger Rechtsbehelfsbelehrung wird nach § 356 Abs. 2 AO grundsätzlich eine
Jahresfrist vorgeschlagen.

Das Ergebnis ist nur ein **Kontrollvorschlag**. Bekanntgabeweg, maßgebliches
Ausgangsdatum, Empfänger, Feiertagsorte und Rechtsbehelfsbelehrung müssen
belegt beziehungsweise fachlich gewürdigt werden. Die Engine trifft keine
abschließende Beweisentscheidung über Zugang, Vollmacht oder Zustellung.

## Wann gilt die Regel?

Die Regel gilt für anfechtbare Verwaltungsakte mit regulärer Einspruchsfrist
nach § 355 Abs. 1 AO und für folgende dokumentierte Bekanntgabewege:

- einfacher Postversand im Inland nach § 122 Abs. 2 Nr. 1 AO,
- einfacher Postversand ins Ausland nach § 122 Abs. 2 Nr. 2 AO,
- unmittelbare elektronische Übermittlung nach § 122 Abs. 2a AO und
- ein durch eine andere Regel bereits rechtlich festgestellter Bekanntgabetag.

Die Vier-Tage-Fassung gilt nicht pauschal für „Bescheide ab 2025“. Nach
Art. 97 § 1 Abs. 15 EGAO ist für Post und unmittelbare elektronische
Übermittlung das tatsächliche Aufgabe- beziehungsweise Übermittlungsdatum
maßgeblich. Frühere Vorgänge benötigen die damalige Drei-Tage-Fassung.

Nicht umfasst sind insbesondere die Bereitstellung zum Datenabruf nach
§ 122a AO, öffentliche Bekanntgabe, noch nicht ausgewertete förmliche
Zustellung, zweifelhafte Empfangsvollmachten, mehrere Beteiligte und besondere
Rechtsbehelfsfristen.

## Benötigte Angaben

- Art des Verwaltungsakts und Anwendbarkeit des § 355 Abs. 1 AO
- tatsächlicher Bekanntgabeweg
- tatsächlicher Aufgabe- oder Absendungstag; das Bescheiddatum genügt dafür
  nicht
- tatsächlicher Bekanntgabeadressat und Empfänger einschließlich Vollmacht
- Ort des Empfängers für die Feiertagsprüfung der Bekanntgabefiktion
- Sitz der zuständigen Finanzbehörde für die Feiertagsprüfung des Fristendes
- Zugangslage: unbestritten, früher tatsächlich dokumentiert, vollständig
  bestritten oder behauptet beziehungsweise festgestellt später
- Tatsachenvortrag und Nachweise bei abweichendem Zugang
- Ergebnis der Belehrungsprüfung: `WIRKSAM`, `UNWIRKSAM` oder `UNKLAR`
  mit Begründung

## Entscheidungslogik

### 1. Bekanntgabetag bestimmen

| Bekanntgabeweg oder Umstand                                   | Kontrollfolge                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Inlandspost, Aufgabe nach dem 31.12.2024                      | vierter Tag nach nachgewiesener Postaufgabe; danach gegebenenfalls § 108 Abs. 3 AO                  |
| unmittelbare elektronische Übermittlung nach dem 31.12.2024   | vierter Tag nach nachgewiesener Absendung; danach gegebenenfalls § 108 Abs. 3 AO                    |
| Auslandspost                                                  | ein Monat nach nachgewiesener Postaufgabe; danach gegebenenfalls § 108 Abs. 3 AO                    |
| förmlich, persönlich oder sonst rechtlich festgestellt        | der aus der gesonderten Regel festgestellte Bekanntgabetag                                          |
| tatsächlicher Zugang vor dem gesetzlichen Fiktionstag         | Fiktionstag bleibt maßgeblich                                                                       |
| Zugang vollständig bestritten                                 | kein automatischer Bekanntgabetag; manuelle Beweisprüfung                                           |
| späterer Zugang schlüssig behauptet und fachlich festgestellt | festgestellter späterer Zugang                                                                      |
| Aufgabe- oder Absendetag unbekannt                            | keine Fiktionsberechnung; festgestellten tatsächlichen Zugang nutzen oder nur Risikotermin ausgeben |

Das Bescheiddatum darf nicht als festgestellter Aufgabe- oder Absendungstag
ausgegeben werden. Ein daraus erzeugter früher Kontrolltermin muss sichtbar als
interner Risikotermin gekennzeichnet sein.

Wird `ACTUAL_ACCESS_DETERMINED` als Ausgangsbasis gewählt, bezeichnen
Ausgangsdatum und Zugangstag denselben fachlich festgestellten Bekanntgabetag.
Abweichende Datumswerte sind widersprüchlich und werden in Anwendung und
Datenbank abgewiesen.

### 2. Rechtsbehelfsbelehrung einordnen

Ein vorhandener Abschnitt mit der Überschrift „Rechtsbehelfsbelehrung“ beweist
noch nicht deren Wirksamkeit. § 356 Abs. 1 AO verlangt in der verwendeten Form
eine Belehrung über Einspruch, zuständige Finanzbehörde, deren Sitz und Frist.

| Prüfergebnis                     | Fristvorschlag                                    |
| -------------------------------- | ------------------------------------------------- |
| `WIRKSAM`                        | grundsätzlich ein Monat ab Bekanntgabe            |
| `UNWIRKSAM` oder Belehrung fehlt | grundsätzlich ein Jahr ab Bekanntgabe             |
| `UNKLAR`                         | kein automatischer Abschluss; Berufsträgerprüfung |

Die Jahresfrist ist keine ausnahmslose Höchstfrist; § 356 Abs. 2 AO enthält
weitere Sonderfälle.

### 3. Monats- oder Jahresfrist berechnen

Der Bekanntgabetag wird als auslösendes Ereignis nach § 187 Abs. 1 BGB nicht
mitgerechnet. Die Frist endet nach § 188 BGB grundsätzlich mit Ablauf des
Tages, der seiner Zahl nach dem Bekanntgabetag entspricht. Fehlt dieser Tag im
Ablaufmonat, endet sie mit dessen letztem Tag.

Für das Fristende ist `TAX-DEADLINE-WORKDAY-001` anzuwenden. Der
Feiertagsort des Fiktionstags und der Feiertagsort des Einspruchsfristendes
können voneinander abweichen.

## Ausnahmen und Grenzfälle

- Ein früher tatsächlicher Eingang verkürzt die gesetzliche Fiktionsfrist
  nicht allein deshalb.
- Die Fiktion setzt einen feststehenden Aufgabe- oder Absendungstag voraus.
- Vollständiger Nichtzugang und lediglich späterer Zugang sind getrennt zu
  behandeln.
- Bei substantiiert behauptetem späterem Zugang bleibt die abschließende
  Beweiswürdigung außerhalb der Engine.
- Bei behauptetem späterem Zugang zeigt das Produkt nebeneinander den
  Kontrolltermin aus der gesetzlichen Fiktion und einen Vergleichstermin aus
  dem behaupteten Zugang. Keiner der beiden Werte wird dabei als festgestellte
  Rechtsfrist freigegeben.
- Zugangsvollmacht, fehlerhafter Adressat, öffentliche Bekanntgabe, mehrere
  Beteiligte und besondere Zustellung benötigen eigene Regeln.

### Nachweis und Freigabe im Produkt

Die Erfassung unterscheidet `CLAIMED`, `SUBSTANTIATED` und
`PROFESSIONALLY_DETERMINED`. Ein behaupteter Nichtzugang oder späterer Zugang
blockiert die automatische Fristfeststellung. Ein tatsächlicher oder späterer
Zugang wird nur mit dem Status `PROFESSIONALLY_DETERMINED` rechnerisch
verwendet; für andere als einfache Post-/Elektronikwege ist ein solcher
festgestellter Zugangstag Pflicht. Zu Ausgangs- und Zugangsnachweisen sind
beschreibende Notizen vorgesehen.

Bei Post und unmittelbarer elektronischer Übermittlung besitzt ein früher
erfasster Zugang den eigenen Vorgangszustand `EARLIER_RECEIPT_RECORDED`. Er
setzt `DISPATCH_DATE` als Vergleichsbasis voraus und verkürzt den Fiktionstag
nicht; ohne mindestens substantiierten Ausgangsnachweis bleibt die Rechnung
manuell. Ein nur behaupteter späterer Zugang hält die Fiktionsrechnung als
Kontrollszenario fest und speichert zusätzlich die alternative Fristrechnung
aus dem behaupteten Zugangstag.

Diese Vorgangszustände sind nicht mit `professional_review` dieses
Katalogdokuments gleichzusetzen. Außerdem prüft das Produkt derzeit weder eine
verknüpfte Belegdatei noch, ob die auswählende Person tatsächlich eine
berufsrechtlich qualifizierte Freigabe erteilen darf. Die Bezeichnung
`PROFESSIONALLY_DETERMINED` ist daher eine dokumentierte Eingabe, keine
technisch unabhängig bestätigte Berufsträgerentscheidung.

## Beispiele

### Normalfall

Ein Inlandsbescheid wird nachweislich am Mittwoch, 4. Februar 2026, zur Post
gegeben. Der vierte Tag ist Sonntag, 8. Februar. Ist Montag am Empfängerort
kein Feiertag, gilt der Bescheid am 9. Februar als bekannt gegeben. Bei
wirksamer Belehrung endet die Monatsfrist grundsätzlich am 9. März; dieses
Datum ist nochmals am Sitz der zuständigen Finanzbehörde zu prüfen.

### Unbekannter Postaufgabetag

Der Bescheid trägt das Datum 1. April 2026, ein Postaufgabevermerk fehlt. Die
Fiktion darf nicht aus dem Bescheiddatum berechnet werden. Ist ein tatsächlicher
Zugang anderweitig belastbar festgestellt, kann dieser als Bekanntgabetag
dienen; andernfalls ist nur ein sichtbar markierter interner Risikotermin
zulässig.

### Späterer Zugang

Der Mandant trägt einen späteren Eingang vor und legt
Posteingangsdokumentation sowie Umschlag vor. TaxTronik darf den späteren Tag
nicht allein aufgrund der Eingabe freigeben, sondern muss den Nachweis zur
fachlichen Würdigung vorlegen. Bis dahin zeigt die Anwendung sowohl das
Szenario aus der gesetzlichen Fiktion als auch das alternative Szenario aus
dem behaupteten Zugang; beide bleiben ausdrücklich manuell zu prüfen.

## Umsetzung in TaxTronik

`assessAppealDeadline` trennt Inlandspost, unmittelbare elektronische
Übermittlung, Auslandspost und einen bereits fachlich festgestellten
Bekanntgabetag. Die Drei-/Vier-Tage-Auswahl knüpft an den als tatsächlichen
Aufgabe- oder Übermittlungstag klassifizierten Ausgangstag an. Fehlt dieser,
wird das Bescheiddatum nur bei ausdrücklicher Basis
`DOCUMENT_DATE_RISK_ONLY` für einen getrennt gespeicherten internen
Risikotermin verwendet; Bekanntgabetag und Einspruchsfrist bleiben dann leer.

Die öffentliche API von `@taxtronik/tax` exportiert für Rechtsbehelfsfristen
nur die nachweisorientierten `assess*`-Funktionen. Die früheren
Convenience-Helper bleiben intern und sind als veraltet markiert, damit neue
Aufrufer die erforderliche Tatsachen- und Nachweislage nicht umgehen.

Die Maske und Persistenz führen Ausgangsbasis und -nachweis,
Zugangssituation und -nachweis, Empfänger, Behörde, getrennte
Feiertagskontexte einschließlich örtlicher Feiertage, die dreistufige
Belehrungsprüfung samt Pflichtnotiz sowie Rechenstatus, Regelversion und
manuelle Prüfgründe. Unklarer oder bestrittener Zugang, unklare Belehrung und
unvollständige Kalenderkontexte liefern keinen scheinbar abschließenden
Fristwert.

Der Verfahrensstatus unterscheidet inzwischen `TEILABHILFE` von
`TEILEINSPRUCHSENTSCHEIDUNG`; nur eine (Teil-)Einspruchsentscheidung kann eine
Klagefrist eröffnen. Bei einer Teilabhilfe speichert das Fachobjekt den
tatsächlichen Bekanntgabetag des Teilabhilfebescheids und die dokumentierende
Person als paarigen Nachweis; der Tag darf nicht vor der Einspruchseinlegung
dokumentiert werden, und spätere Abhilfe, Einspruchsentscheidung,
Klageeinreichung oder Bestandskraft dürfen ihn nicht unterschreiten. Der
Nachweis bleibt in Folgestatus erhalten. Das unveränderbare Audit dupliziert
davon nur ein boolesches Nachweismerkmal. Ereignistag und handelnde Person
werden auch für die weiteren wesentlichen Übergänge gespeichert, und der
Abschlussstatus heißt `BESTANDSKRAEFTIG`.
Dieser Abschluss ist in der Server-Action auf Admin oder Partner beschränkt und
verlangt eine Begründung von mindestens zehn Zeichen. Aus `GEPRUEFT` wird er
nur bei berechneter Einspruchsfrist ohne offenen manuellen Prüfbedarf, nach
deren Ablauf — technisch frühestens am Folgetag des gespeicherten
Fristenddatums — und ohne dokumentierten Einspruch zugelassen. Aus
`ZURUECKGEWIESEN` muss die dokumentierte Klagefrist ebenfalls vollständig
abgelaufen sein; auch hier ist der Fristtag selbst gesperrt. Für die anderen
zugelassenen Ausgangsstatus bestehen diese beiden besonderen Frist-Gates nicht.

Die unveränderbaren Audit-Ereignisse duplizieren keine Empfänger- oder
Behördennamen, Ortsangaben, Ereignisdaten oder Begründungsfreitexte. Eine
Positivliste übernimmt nur pseudonyme Referenzen und Nachweismerkmale; ein an
die Ressourcen-ID gebundener SHA-256-Fingerprint bindet den Fachdatensatz
beziehungsweise die Änderung an das Ereignis. Die Klarwerte bleiben im
Fachobjekt mit dessen eigener Retention.

Der tägliche Einspruchsfristen-Reminder berücksichtigt nur Vorschläge mit
`deadlineCalculationStatus = CALCULATED` und ohne offenen manuellen
Prüfbedarf. 14, 7 und 1 Tag vor Fristende revalidiert der Worker Frist,
Quellstatus und Empfänger im selben Tenant-Transaktionskontext wie den
Notification-Insert. Vorrang hat die dokumentierte prüfende Person nur bei
fortbestehender Aktivität und aktuellem Mandantenzugriff; andernfalls werden
aktive Hauptbearbeiter und danach aktive Admins/Partner verwendet. Ohne
berechtigtes Ziel wird keine globale Notification angelegt.

## Bekannte Abweichungen und Grenzen

- Nachweisstatus und Notiz sind nicht an ein unveränderbares Quelldokument oder
  einen technischen Versandbeleg gebunden. Tatsächlicher Adressat,
  Empfangsvollmacht, förmliche Zustellung und mehrere Beteiligte werden nicht
  als vollständige eigene Fachmodelle geprüft.
- Die Anwendung besitzt keine gesonderte Berufsträgerrolle, Freigabeaktion oder
  Vier-Augen-Prüfung für `PROFESSIONALLY_DETERMINED`, Kalenderbestätigung oder
  den berechneten Fristvorschlag. Die fachliche Freigabe fehlt.
- Nach einer Änderung fristrelevanter Tatsachen invalidiert die Datenbank den
  alten Vorschlag fail-closed. Die vorbereitete, optimistisch gesperrte
  Neubewertungsfunktion ist für `taxtronik_app` ausdrücklich nicht ausführbar,
  solange keine autorisierte Server-Action Modul-, Rollen- und
  Mandantenzugriff einschließlich `RESTRICTED`/vertraulich prüft. Eine
  bedienbare Editier-/Neubewertungsaktion existiert derzeit nicht.
- Das Admin-/Partner-Gate bei `BESTANDSKRAEFTIG` ist eine technische
  Rollenbeschränkung. Insbesondere die Rolle Admin belegt keine
  Berufsträgerqualifikation; die Begründung ist außerdem nicht an einen
  unveränderbaren Entscheidungsnachweis gebunden.
- Das Statusmodell ist trotz der getrennten
  `TEILEINSPRUCHSENTSCHEIDUNG` **linear**: Ein einziger `TaxNotice.status` kann
  nicht gleichzeitig abbilden, dass für den entschiedenen Teil eine
  Klagefrist läuft, während der übrige Einspruch mit eigenem Gegenstand und
  Umfang fortgeführt wird. Teilgegenstände und parallele Verfahrenszweige sind
  nicht strukturiert gespeichert.
- Die Regel ersetzt kein vollständiges Bekanntgabe-, Zustellungs-, Vollmachts-
  oder Rechtsbehelfsmodul.

Bis zur Umsetzung dieser Punkte bleibt die technische Umsetzung
**teilweise**. `professional_review.status` bleibt `unreviewed`, bis ein
Berufsträger Regelinhalt und Produktverhalten geprüft hat.

## Fachliche Prüffragen

- Welche Rolle und welcher Vier-Augen-Schritt dürfen einen Ausgangs- oder
  Zugangstag fachlich feststellen und den Fristvorschlag freigeben?
- Wie werden Nachweise unveränderbar mit der jeweiligen Tatsachenfeststellung
  verknüpft?
- Wie werden Teilgegenstände und gleichzeitig laufende Einspruchs- und
  Klagezweige modelliert?
- Werden sämtliche Pflichtbestandteile des § 356 Abs. 1 AO einzeln geprüft?
- Ist die Abgrenzung zur eigenen §-122a-Regel eindeutig?

## Technische Nachweise

`legal-assessments.ts` und seine Tests decken Bekanntgabewege, Drei-/Vier-Tage-
Cutover, unbekannte Versanddaten, tatsächlichen und behaupteten Zugang,
getrennte Feiertagsorte, unvollständige Kalender sowie Monats-/Jahresfrist und
die dreistufige Belehrungsprüfung ab. `notice-assessment.ts` und die
Bescheid-Actions bilden diese Ergebnisse auf die Persistenz ab. Die
Transitionstests prüfen Ereignisnachweise, `TEILABHILFE` ohne Klagefrist,
`TEILEINSPRUCHSENTSCHEIDUNG` mit Klagefrist sowie Frist-, Prüf- und
Begründungs-Gates für `BESTANDSKRAEFTIG`. Der DB-Integrationstest erzwingt für
die Teilabhilfe das Paar aus Bekanntgabetag und dokumentierender Person, die
Ereignisreihenfolge und den Erhalt beider Werte im Folgestatus. Der Audit-Test
prüft die Positivliste gegen Namen, Orts-/Falldaten und Begründungsfreitext. Der
Worker-Test prüft das Reminder-Gate für vollständig berechnete Vorschläge, die
aktuelle Zugriffs-Fallbackkette und das Verbot globaler Empfänger. Nicht belegt
und deshalb für die App-Rolle gesperrt ist die vorbereitete
Neubewertungsfunktion ohne autorisierten Aufrufer. Nicht belegt sind eine an
die Berufsträgerqualifikation gebundene fachliche Freigabe,
beleggebundene Evidenz und parallele Teilverfahren.
