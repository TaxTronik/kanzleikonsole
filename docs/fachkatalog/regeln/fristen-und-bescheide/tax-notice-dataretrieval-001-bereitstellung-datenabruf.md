---
id: TAX-NOTICE-DATARETRIEVAL-001
title: Bekanntgabetag bei Bereitstellung zum Datenabruf nach § 122a AO bestimmen
domain: fristen-und-bescheide
rule_type: professional_interpretation
jurisdiction: DE
validity:
  valid_from: '2026-01-01'
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
    Altfall, Einwilligungsjahr 2026 und Regelfall ab 2027 werden anhand des
    Erlassdatums getrennt; Bereitstellungsnachweis, Postantrag,
    Benachrichtigungsabweichung, zwei Feiertagsorte und §-110-Prüfhinweis sind
    umgesetzt. Belegbindung und unabhängige fachliche Freigabe fehlen.
sources:
  - kind: official_law
    citation: § 122a AO
    url: https://www.gesetze-im-internet.de/ao_1977/__122a.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: Art. 97 § 1 Abs. 15 EGAO
    url: https://www.gesetze-im-internet.de/aoeg_1977/BJNR033419976.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: Art. 97 § 28 Abs. 2 EGAO
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__28.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 108 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 110 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__110.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: AEAO-Änderung zu § 122a vom 29.01.2026
    url: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2026-01-29-aenderung-aeao-46-usw.pdf?__blob=publicationFile&v=6
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: AEAO-Änderung zu § 122a vom 27.02.2026
    url: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2026-02-27-aenderung-aeao-122a.pdf?__blob=publicationFile&v=5
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: BMF-Schreiben vom 13.08.2026 zur Bekanntgabe durch Bereitstellung zum Datenabruf
    url: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/2026-08-13-bekanntgabe-von-steuerverwaltungsakten.pdf?__blob=publicationFile&v=4
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/tax/src/engine.ts
  - packages/tax/src/index.ts
  - packages/tax/src/legal-assessments.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/data-retrieval.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-assessment.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/actions.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260823000000_tax_notice_data_retrieval_cutover/migration.sql
  - packages/db/prisma/migrations/20260823201000_tax_professional_control_model/migration.sql
test_refs:
  - packages/tax/src/__tests__/legal-assessments.test.ts
  - packages/tax/src/__tests__/plausibility-engine.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/data-retrieval.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-assessment.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-NOTICE-APPEAL-001
  - TAX-DEADLINE-WORKDAY-001
  - TAX-CONTROL-STATUS-001
tags:
  - bekanntgabe
  - datenabruf
  - elster
  - einspruch
---

# TAX-NOTICE-DATARETRIEVAL-001 — Bekanntgabetag bei Bereitstellung zum Datenabruf nach § 122a AO bestimmen

## Kurzfassung

Ein nach § 122a AO zum Datenabruf bereitgestellter Verwaltungsakt gilt
grundsätzlich am vierten Tag nach seiner Bereitstellung als bekannt gegeben.
Fällt dieser Tag auf einen Sonnabend, Sonntag oder am regelmäßig maßgeblichen
Empfängerort geltenden gesetzlichen Feiertag, ist § 108 Abs. 3 AO zu prüfen.

Anknüpfungspunkt ist die nachgewiesene Bereitstellung des Verwaltungsakts,
nicht die Benachrichtigungs-E-Mail, der erstmalige Abruf oder die tatsächliche
Kenntnisnahme. Die Benachrichtigung bleibt trotzdem eine gesetzliche Pflicht am
Tag der Bereitstellung.

## Wann gilt die Regel?

Die Regel gilt für Verwaltungsakte, die nach § 87a Abs. 8 AO in einem dafür
vorgesehenen Nutzerkonto zum Datenabruf bereitgestellt werden und deren
Bekanntgabe sich nach § 122a AO richtet.

Sie gilt nicht für unmittelbare elektronische Übermittlung nach § 122
Abs. 2a AO, bloße E-Mail-Anhänge, Postversand oder Fälle, in denen nur eine
Benachrichtigung, nicht aber die tatsächliche Bereitstellung belegt ist. Die
tatsächlich verwirklichte Bekanntgabeform ist maßgeblich.

### Rechtsstand 2026

Die Neufassung des § 122a AO gilt nach Art. 97 § 28 Abs. 2 EGAO für nach dem 31. Dezember 2025 erlassene Verwaltungsakte. § 122a Abs. 1 Satz 2 AO wird
abweichend davon erst für nach dem 31. Dezember 2026 erlassene
Verwaltungsakte wirksam.

Für 2026 besteht ein amtlicher Quellenkonflikt: Der AEAO vom 29. Januar 2026
nennt neben Einwilligung auch anderweitig erkennbare Akzeptanz; das spätere
BMF-Schreiben vom 13. August 2026 beschreibt den operativen Prozess enger.
Als konservative, beweisbare Produktvoraussetzung ist deshalb für 2026 eine
zuvor aktiv im ELSTER-Konto beziehungsweise für die elektronische Vollmacht
erteilte Einwilligung zu dokumentieren. Diese vorsichtige Festlegung ist noch
nicht berufsträgerlich freigegeben.

### Rechtsstand ab 2027

Ab 2027 soll die Bereitstellung insbesondere in den Fällen des § 122a Abs. 1
Satz 2 AO zum Regelfall werden, wenn die dort genannten Voraussetzungen
vorliegen und kein wirksamer Antrag auf postalische Bekanntgabe besteht.
Antrag und Widerruf wirken nur für die Zukunft und ab Zugang bei der
Finanzbehörde. Die tatsächliche Bekanntgabeform bleibt dennoch festzustellen;
aus einer elektronischen Erklärung folgt kein Beweis der konkreten
Bereitstellung.

## Benötigte Angaben

- Art und Erlassdatum des Verwaltungsakts
- tatsächlich verwendeter Bekanntgabeweg
- Abrufberechtigter und Bekanntgabeempfänger einschließlich Vollmacht
- Nutzerkonto und dessen Zuordnung
- Bereitstellungsdatum und technischer Nachweis
- Ort des Abrufberechtigten für die Feiertagsprüfung
- für 2026: aktiv erteilte und nachweisbare Einwilligung
- ab 2027: Status und Zugang eines Postantrags beziehungsweise Widerrufs
- Benachrichtigungsdatum und technisches Ergebnis als getrennte Angaben
- tatsächlicher Abrufzeitpunkt nur als Sachverhalts- und Kontrollinformation
- Bewertung, ob ein manueller Wiedereinsetzungs-Prüffall besteht

## Entscheidungslogik

### 1. Tatsächliche Bekanntgabeform feststellen

| Vorgang                                            | Folge                              |
| -------------------------------------------------- | ---------------------------------- |
| Verwaltungsakt nach § 87a Abs. 8 AO bereitgestellt | Prüfung nach § 122a AO fortsetzen  |
| unmittelbar elektronisch übermittelt               | § 122 Abs. 2a AO anwenden          |
| postalisch übermittelt                             | § 122 Abs. 2 AO anwenden           |
| nur Benachrichtigung, Bereitstellung nicht belegt  | kein festgestellter Bekanntgabetag |
| Form widersprüchlich oder unbekannt                | manuelle Prüfung                   |

Eine Benachrichtigungs-E-Mail ist kein Ersatzwert für das
Bereitstellungsdatum.

### 2. Zulässigkeit nach Rechtsstand prüfen

| Rechtsstand und Sachverhalt                                               | Folge                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2026, aktive Einwilligung und tatsächliche Bereitstellung belegt          | § 122a AO kann als Standardfall berechnet werden                                     |
| 2026, Einwilligungsstatus unbekannt oder negativ                          | kein freigabefähiger Automatismus                                                    |
| ab 2027, Voraussetzungen erfüllt und kein wirksamer Postantrag            | bei belegter Bereitstellung weiterrechnen                                            |
| ab 2027, wirksamer Postantrag spätestens am Bereitstellungstag zugegangen | Bekanntgabeform und mögliche Wiedereinsetzung getrennt prüfen                        |
| ab 2027, wirksamer Postantrag erst nach dem Bereitstellungstag zugegangen | die frühere Bereitstellung nicht allein deshalb blockieren; spätere Vorgänge trennen |

Die Regimeauswahl hängt am Erlassdatum, nicht am System-, Abruf- oder
Bereitstellungsdatum.

### 3. Fiktionstag und Folgefrist berechnen

Bei nachgewiesenem Bereitstellungsdatum wird der Bereitstellungstag nicht
mitgezählt und der vierte folgende Kalendertag ermittelt. Ein Ausschlusstag
wird nach `TAX-DEADLINE-WORKDAY-001` verschoben. Ohne Nachweis darf die
Engine nicht aus Bescheid-, Benachrichtigungs- oder Download-Datum
zurückrechnen.

Der fachlich festgestellte Bekanntgabetag wird anschließend an
`TAX-NOTICE-APPEAL-001` übergeben. Dort werden Belehrung, Fristlänge und der
für das Fristende gesondert maßgebliche Feiertagsort geprüft.

### 4. Benachrichtigung und Abruf getrennt behandeln

| Umstand                                               | Folge                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Benachrichtigung erfolgreich                          | nur Hinweis- und Kontrollinformation                                                      |
| Benachrichtigung fehlgeschlagen oder nicht zugegangen | Fiktionstag grundsätzlich unverändert; Pflichtabweichung und §-110-Prüffall dokumentieren |
| früher oder später abgerufen                          | keine automatische Änderung des Fiktionstags                                              |
| überhaupt nicht abgerufen                             | Fiktionstag wird nicht allein dadurch beseitigt                                           |

Eine Wiedereinsetzung darf nicht automatisch bejaht und nicht durch Änderung
des Bekanntgabetags simuliert werden.

## Ausnahmen und Grenzfälle

- Erwartete Post und tatsächlich erfolgte Bereitstellung sind getrennt von
  einem möglichen Wiedereinsetzungsfall zu bewerten.
- Ein Benachrichtigungsfehler ändert die Fiktion grundsätzlich nicht, ist aber
  als Verstoß gegen die Same-Day-Benachrichtigungspflicht zu dokumentieren.
- Empfangsvollmacht, gemeinsame Bekanntgabe, Portalberechtigung und
  fehlerhafte Bekanntgabe benötigen Einzelfallprüfung.
- Der technische Umfang der Finanzverwaltung kann sich ändern und darf nicht
  als dauerhafte gesetzliche Voraussetzung fest codiert werden.

### Nachweis und Freigabe im Produkt

Die Assessment-API unterscheidet eine bloß behauptete beziehungsweise
unbekannte Bereitstellung von `TECHNICALLY_EVIDENCED` und
`PROFESSIONALLY_DETERMINED`. Die Maske bildet dies auf `CLAIMED`,
`SUBSTANTIATED` und `PROFESSIONALLY_DETERMINED` ab. Ohne mindestens
substantiierten Bereitstellungsnachweis wird kein Bekanntgabe- oder Fristdatum
ausgegeben. Ein technischer Nachweis kann die Rechnung tragen, bleibt aber als
fachlich noch zu prüfender Vorgang gekennzeichnet.

Diese Vorgangszustände sind nicht mit `professional_review` dieses
Katalogdokuments gleichzusetzen. Ein Nachweisstatus ist derzeit nur mit einer
Pflichtnotiz, nicht mit einem unveränderbaren Quelldokument verknüpft. Auch
`PROFESSIONALLY_DETERMINED` kann von jedem für das Modul berechtigten
Mitarbeiter ausgewählt werden; eine gesonderte Berufsträger- oder
Vier-Augen-Freigabe ist nicht implementiert.

## Beispiele

### Bereitstellung 2026 mit aktiver Einwilligung

Die aktive Einwilligung des Empfangsbevollmächtigten und die Bereitstellung am
Dienstag, 10. März 2026, sind nachgewiesen. Der vierte Tag ist Sonnabend, 14. März. Ist Montag am Empfängerort kein Feiertag, gilt der Verwaltungsakt
grundsätzlich am 16. März als bekannt gegeben.

### Fehlgeschlagene Benachrichtigung

Die Bereitstellung ist belegt, die gesetzlich vorgesehene Benachrichtigung
schlägt technisch fehl. Der Fiktionstag wird nicht automatisch verschoben.
Der Fehler ist gesondert zu dokumentieren und kann einen manuellen
Wiedereinsetzungs-Prüffall auslösen.

### Erwartete Post, tatsächliche Bereitstellung

Ab 2027 ging ein Postantrag vor oder am Tag der elektronischen Bereitstellung
bei der Finanzbehörde ein. TaxTronik dokumentiert den tatsächlichen Vorgang,
darf ihn aber nicht ohne fachliche Prüfung als Standardfall abschließen. Geht
der dokumentierte Postantrag erst nach der bereits erfolgten Bereitstellung
ein, blockiert die Engine die Berechnung dieses früheren Vorgangs nicht allein
wegen des späteren Zugangs; für spätere Verwaltungsakte ist der Antrag erneut
zu würdigen.

## Umsetzung in TaxTronik

`assessDataRetrievalDeadline` und die Bescheidmaske führen Erlassdatum,
Bereitstellung, Nachweisstatus, Empfänger- und Behördenkontext,
Benachrichtigung, Abruf, Einwilligung 2026 sowie Voraussetzungen und Postantrag
ab 2027 getrennt. Die Regimeauswahl erfolgt anhand des Erlassdatums:

- bis 2025 wird der altrechtliche Benachrichtigungsweg verwendet; bei
  bestrittenem oder verspätetem Zugang kann nur ein dokumentierter tatsächlicher
  Abruf den Ausgangstag liefern. Ohne Streitfall darf nur ein bestätigter
  Versandstatus die Fiktionsrechnung auslösen; `FAILED`, `UNKNOWN` oder ein
  nicht erfasstes Ergebnis bleiben gesperrt. Beim Übergang von drei auf vier
  Fiktionstage ist nach Art. 97 § 1 Abs. 15 EGAO der Bereitstellungstag
  maßgeblich, auch wenn die Benachrichtigung erst im Folgejahr versandt wurde,
- 2026 wird nur bei dokumentierter aktiver Einwilligung automatisch gerechnet,
- ab 2027 werden bestätigte Voraussetzungen und das Fehlen eines bereits
  wirksamen Postantrags verlangt. Bei `EFFECTIVE` vergleicht die Engine den
  gespeicherten Zugangstag des Antrags mit dem Bereitstellungstag: Zugang bis
  einschließlich dieses Tages blockiert den Automatismus, ein erst danach
  zugegangener Antrag nicht den bereits früher bereitgestellten Vorgang.

Im Neurecht werden Bereitstellung plus vier Tage und anschließend die
Einspruchsfrist mit getrenntem Empfänger- und Behördenkalender bewertet.
Fehlgeschlagene oder verspätete Benachrichtigung verändert den Fiktionstag
nicht, setzt aber einen Wiedereinsetzungs-Prüfhinweis. Ein unbekanntes Ergebnis
bleibt als manueller Prüfgrund sichtbar. Rechenstatus, Regelversion,
Prüfgründe und der §-110-Hinweis werden persistiert; Validierung und
Datenbank-Constraints schützen die zeitliche Trennung der Angaben.

## Bekannte Abweichungen und Grenzen

- Die Einwilligung 2026 und die Voraussetzungen ab 2027 werden derzeit nur als
  Enum-Status gespeichert. Der Postantrag besitzt Status und bei wirksamem
  Antrag einen Zugangstag, aber keinen eigenen Nachweisfreitext. Nur die
  Bereitstellung führt Datum, Nachweisstatus und die allgemeine
  Nachweisnotiz. Keine dieser Angaben wird gegen ELSTER- oder
  Finanzverwaltungsdaten verifiziert oder an einen unveränderbaren Beleg
  gebunden.
- Allgemeine Zugangseinwendungen aus den Post-/Übermittlungswegen sind beim
  Datenabruf technisch gesperrt. Der altrechtliche Streit-/Verspätungsmarker
  ist nur für bis 2025 erlassene Verwaltungsakte zulässig; im Neurecht werden
  Benachrichtigung und Abruf ausschließlich über die §-122a-Felder geführt.
- Die UI unterscheidet beim Neurecht `SENT`, `FAILED` und `UNKNOWN`; verspäteter
  Versand wird aus dem Datum abgeleitet. Ein gesonderter UI-Status
  „nicht zugegangen“ fehlt, obwohl die Assessment-API ihn fachlich kennt.
- Der Wiedereinsetzungsbedarf wird als Prüfhinweis gespeichert. Es gibt keinen
  eigenständigen §-110-Workflow und keine automatische fachliche Entscheidung.
- Empfängername und Feiertagsort werden dokumentiert, aber Vollmacht,
  Nutzerkonto-Zuordnung und tatsächliche technische Abrufberechtigung nicht als
  vollständige eigene Fachobjekte geprüft.
- Eine unabhängige fachliche Freigabe des Bekanntgabewegs, des Nachweises und
  des berechneten Fristvorschlags fehlt.

Die Implementierung ist deshalb **teilweise**.

## Fachliche Prüffragen

- Welche unveränderbare operative Evidenz belegt Einwilligung,
  Bereitstellung und Postantrag?
- Welche Rolle darf den Vorgangsstatus `PROFESSIONALLY_DETERMINED` und den
  Fristvorschlag fachlich freigeben?
- Muss „Benachrichtigung nicht zugegangen“ als eigener UI-Status aufgenommen
  werden?
- Wie wird aus dem gespeicherten Hinweis ein nachverfolgbarer §-110-Prüffall?
- Wie werden Vollmacht, Nutzerkonto und Abrufberechtigung verifiziert?
- Wann muss der Rechtsstand erneut fachlich und technisch geprüft werden?

## Technische Nachweise

Die Tests in `legal-assessments.test.ts` belegen Erlassdatum-Cutover,
Altfall-Einwendungen, Einwilligung 2026, Voraussetzungen und Postantrag ab 2027,
einschließlich dessen Zugangszeitpunkt vor/am beziehungsweise nach der
Bereitstellung, den kalenderjahresübergreifenden Drei-/Vier-Tage-Cutover nach
dem Bereitstellungstag, Nachweisstufen, getrennte Feiertagsorte sowie
Benachrichtigungsabweichung mit unverändertem Fiktionstag und
§-110-Prüfhinweis. Die Webtests prüfen die Abbildung und Validierung der
Eingaben. Datenbank-Constraints und Migrationen sind als Code-Nachweise
verknüpft. Nicht belegt sind externe Evidenzverifikation, rollenabhängige
fachliche Freigabe und ein vollständiger Wiedereinsetzungsworkflow.
