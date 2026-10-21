---
id: TCMS-AKTEUR-001
title: Akteursbestätigungen an das Tax-CMS höchstens im Umfang des eigenen Mandantenzugriffs ausstellen
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger TCMS und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Die kanzleikonsole bestätigt dem Tax-CMS je Aufruf Person, Rollen und
    Mandantenbezug ausschließlich aus der geprüften Sitzung und dem aktuellen
    Datenbestand; ohne Mandantenzugriff nach ACCESS-CLIENT-MODE-001 entsteht
    keine Bestätigung und kein Aufruf. Seiten und Aktionen der Oberflächen
    nutzen dafür zentrale Helfer; Personen aus Formularen werden gegen den
    Mandanten geprüft. Anforderungen, die ein Kontakt im Portal per Code
    bestätigt (Freigaben, Risikoakzeptanzen, Kenntnisnahmen), gehen nur an
    Kontakte mit aktivem Portalzugang; Rollen dürfen auch Kontakte ohne
    Portalzugang haben. Die Abbildung (Kanzleileitung, zuständige
    Berufsträgerin, „nur meine Mandate“, Rechtsform des Ankers) ist durch
    Produktentscheidung bestätigt; die fachliche Freigabe steht aus.
sources:
  - kind: product_documentation
    citation: Anbindung des Tax-CMS, Abschnitt 4 (Akteursabbildung) und Abschnitt 7 (Oberflächen)
    path: docs/development/tcms-anbindung.md
    checked_at: '2026-10-19'
    primary: true
  - kind: product_documentation
    citation: Leitfaden Tax-CMS-Oberflächen
    path: docs/development/tcms-oberflaechen.md
    checked_at: '2026-10-19'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation Tax-CMS
    path: docs/anwenderdoku/tax-cms.md
    checked_at: '2026-10-19'
    primary: false
code_refs:
  - apps/web/src/server/tcms/akteur.ts
  - apps/web/src/server/tcms/seite.ts
  - apps/web/src/server/tcms/aktion.ts
  - apps/web/src/server/tcms/personen.ts
  - apps/web/src/server/tcms/namen.ts
  - apps/web/src/server/tcms/mandant.ts
  - apps/web/src/server/tcms/feststellungen/personen.ts
  - apps/web/src/server/tcms/programm/zustaendigkeit.ts
  - apps/web/src/server/tcms/programm/einrichtung.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/actions.ts
  - apps/web/src/server/tcms/bereich-b/personen-auswahl.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/actions.ts
  - apps/web/src/server/tcms/ereignisse/personen.ts
  - apps/web/src/server/tcms/route.ts
  - packages/db/src/portal-zugang.ts
  - apps/web/src/components/tcms/empfaenger.ts
  - apps/web/src/components/tcms/risiken/detail.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/teile.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/teile.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/schritte.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontakte/page.tsx
  - apps/worker/src/jobs/tcms-nachrichten.ts
test_refs:
  - apps/web/src/server/tcms/__tests__/seite.test.ts
  - apps/web/src/server/tcms/__tests__/aktion.test.ts
  - apps/web/src/server/tcms/__tests__/zustand.test.ts
  - apps/web/src/server/tcms/__tests__/namen-personen-db.test.ts
  - apps/web/src/server/tcms/__tests__/akteur-db.test.ts
  - apps/web/src/__tests__/client-page-authz.test.ts
  - apps/web/src/server/tcms/__tests__/mandant.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/actions.test.ts
  - apps/web/src/server/tcms/feststellungen/__tests__/personen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/feststellungen/__tests__/actions.test.ts
  - apps/web/src/server/tcms/programm/__tests__/zustaendigkeit-db.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/__tests__/aktionen.test.ts
  - apps/web/src/server/tcms/bereich-b/__tests__/personen-auswahl-db.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/seite.test.tsx
  - apps/web/src/components/tcms/kontrollen/__tests__/kontrollen.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/ereignisse-aktionen.test.ts
  - apps/web/src/app/api/staff/clients/[id]/tcms/ereignisse/anlage/__tests__/route.test.ts
  - apps/web/src/app/portal/(protected)/tcms/__tests__/portal-aktionen.test.ts
  - apps/web/src/app/api/portal/tcms/aufgaben/[id]/anlagen/[nachweisId]/__tests__/route.test.ts
  - apps/web/src/server/tcms/__tests__/route.test.ts
  - apps/web/src/__tests__/tcms-route-authz.test.ts
  - packages/db/src/__tests__/portal-zugang.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/seiten.test.tsx
  - apps/worker/src/jobs/__tests__/tcms-nachrichten-db.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/tax-cms.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
  - TCMS-DIENST-001
tags:
  - tcms
  - akteur
  - mandantenzugriff
  - bestätigung
---

# TCMS-AKTEUR-001 — Akteursbestätigungen an das Tax-CMS höchstens im Umfang des eigenen Mandantenzugriffs ausstellen

## Kurzfassung

Das Tax-CMS leitet seine Rechte (Lesen, Bearbeiten, §-153-Würdigung) aus einer
signierten Akteursbestätigung der kanzleikonsole ab. Die kanzleikonsole stellt
diese Bestätigung nur aus der geprüften Sitzung und dem aktuellen
Datenbestand aus und bestätigt nie mehr, als sie selbst gewährt: einen
Mandantenbezug nur bei Zugriff nach ACCESS-CLIENT-MODE-001, die Rolle
Admin/Partner nur bei aktuellem Rollenstand, Zuständigkeiten nur aus den
Zuordnungen des Mandanten. Ohne Bestätigung findet kein Aufruf statt.

## Wann gilt die Regel?

Die Regel gilt für jeden Aufruf des Tax-CMS aus der kanzleikonsole: Seiten
unter `/staff/tcms`, `/staff/clients/[id]/tcms` und `/portal/tcms`, Server
Actions dieser Bereiche und künftige Hintergrundaufgaben. Sie gilt nicht für
den Health-Check (nur Dienst-Token) und nicht für die Entscheidungen, die das
Tax-CMS auf Grundlage der Bestätigung trifft (siehe TCMS-DIENST-001).

## Benötigte Angaben

- geprüfte Sitzung (Kanzleiperson oder Mandantenkontakt) mit Tenant
- aktueller Rollenstand und Berufsträgereigenschaft der Person
- Mandant des Aufrufziels: aus dem Pfad erst nach der Zugriffsprüfung, im
  Portal ausschließlich aus der Sitzung
- Zuordnungen des Mandanten (Berufsträger, Hauptbearbeitung)
- bei Personen aus Formularen: die erlaubte Personenmenge des Mandanten

## Entscheidungslogik

| Wenn                                                                                        | Dann                                                                                                                                                                                                                                                                                                     | Begründung                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Kanzleiperson mit Zugriff auf den Mandanten (ACCESS-CLIENT-MODE-001)                        | Bestätigung mit `cli` = Mandant, `bt`/`hb` aus den aktuellen Zuordnungen                                                                                                                                                                                                                                 | höchstens der Umfang der eigenen Zugriffsregel                                                   |
| kein Zugriff, Mandant fremd oder nicht vorhanden                                            | keine Bestätigung, kein Aufruf; Seite „Kein Zugriff“ bzw. 404                                                                                                                                                                                                                                            | keine Erweiterung über den Tenant- oder Mandantenzugriff hinaus                                  |
| Rollen der Sitzung weichen vom aktuellen Stand ab, Sitzung abgelaufen oder Person inaktiv   | keine Bestätigung; Hinweis, sich erneut anzumelden                                                                                                                                                                                                                                                       | veraltete Rechte werden nicht bestätigt                                                          |
| `rol.adm`                                                                                   | nur für ADMIN oder PARTNER mit aktuellem Rollenstand                                                                                                                                                                                                                                                     | entspricht der Kanzleileitung in der kanzleikonsole                                              |
| Portfolio oder Arbeitskorb                                                                  | Mandantenliste wie die sichtbaren Mandanten der Person, höchstens 5 000, sonst keine Bestätigung                                                                                                                                                                                                         | keine stille Kürzung, keine zusätzlichen Mandanten                                               |
| Mandantenkontakt                                                                            | `cli` = Mandant der Portal-Sitzung, `bt`/`hb` falsch, nur mit aktivem Portalzugang                                                                                                                                                                                                                       | Portal nie mandantenübergreifend                                                                 |
| Person aus einem Formular (Verantwortliche, Kontaktrollen)                                  | nur Mitarbeiter mit Zugriff auf den Mandanten bzw. Kontakte genau dieses Mandanten; Namen aus der kanzleikonsole                                                                                                                                                                                         | keine Daten eines anderen Mandanten, keine Namen aus Formularfeldern                             |
| Empfänger einer Freigabe, Risikoakzeptanz, Kenntnisnahme oder Zielfreigabe (Code im Portal) | nur Kontakt genau dieses Mandanten mit aktivem Portalzugang (aktiv; Mandant zugelassen, nicht anonymisiert, Mandat nicht beendet; zustellbare Adresse; mindestens einmal angemeldet); sonst feste Meldung vor dem Dienstaufruf, in Auswahllisten gesperrt mit „ohne Portalzugang – kann nicht freigeben“ | Produktentscheidung (Rey Koxha, 21.10.2026); dieselbe Regel wie die Zustellung (MAIL-OUTBOX-001) |
| Kontaktrolle für einen Kontakt ohne Portalzugang                                            | zulässig (Rolle im Tax-CMS), Hinweis in Kontakte & Rollen                                                                                                                                                                                                                                                | Produktentscheidung (Rey Koxha, 21.10.2026)                                                      |
| Portfolio-Filter „nur meine Mandate“                                                        | Mandanten, bei denen die Person zuständige Berufsträgerin oder Hauptbearbeitung ist (`bt` oder `hb`)                                                                                                                                                                                                     | Produktentscheidung (Rey Koxha, 21.10.2026)                                                      |

## Ausnahmen und Grenzfälle

Die Login-Sperre einer Person verhindert keine Bestätigung für eine bereits
laufende Sitzung; sie sperrt nur neue Passwort-Anmeldungen. Eine Zuordnung
als Berufsträger ohne (noch gültige) Berufsträgereigenschaft gewährt Zugriff,
aber nicht `bt`. Ein Kontakt eines anderen Mandanten wird in Antworten des
Tax-CMS nicht namentlich aufgelöst („Unbekannte Person“).

## Beispiele

### Normalfall

Eine Mitarbeiterin ohne Zuordnung öffnet im Zugriffsmodell OPEN das Cockpit
eines nicht vertraulichen Mandanten. Die Bestätigung enthält den Mandanten
mit `bt` und `hb` falsch; das Tax-CMS zeigt die Daten zum Lesen.

### Grenzfall

Derselbe Mandant wird vertraulich gesetzt, während die Seite offen ist. Der
nächste Aufruf bestätigt keinen Mandantenbezug mehr; die Seite zeigt „Kein
Zugriff“, eine Aktion endet mit derselben festen Meldung, ohne das Tax-CMS zu
fragen.

## Umsetzung in TaxTronik

`apps/web/src/server/tcms/akteur.ts` bildet die Bestätigung (Stufe 2).
Seiten nutzen ausschließlich `tcmsMandantSeite`, `tcmsKanzleiSeite`,
`tcmsAdminSeite` oder `tcmsPortalSeite` (`server/tcms/seite.ts`): Zugriffs-
und Modulprüfung zuerst, dann in einer Tenant-Transaktion Aktivierung und
Akteur. Lesezugriffe setzen Mandant, Akteur und Mandantenliste aus der Seite;
eine Seite kann sie nicht überschreiben. Aktionen nutzen `tcmsKanzleiAktion`
bzw. `tcmsPortalAktion` (`server/tcms/aktion.ts`) mit demselben Ablauf,
Datei-Abrufe den Route-Einstieg `tcmsMandantRoute` bzw. `tcmsPortalRoute`
(`server/tcms/route.ts`; Sitzung zuerst, Mandantenzugriff vor der
Bestätigung). Seiten, Aktionen und Route-Handler lassen einen Endpunkt nur zu,
wenn dessen `akteure` im Register des Vertrags die Art der Fläche nennen
(Kanzlei: `KANZLEI`, Portal: `MANDANT`). Die Web-App bestätigt nur Personen
(KANZLEI, MANDANT); den Systemakteur bildet allein der Zustell-Worker
(MAIL-OUTBOX-001).
Personen aus Formularen prüft `server/tcms/personen.ts`, Namen in Antworten
löst `server/tcms/namen.ts` nur im Tenant bzw. beim Mandanten auf. Name,
Rechtsform und DATEV-Nummer des Mandantenankers stammen aus
`server/tcms/mandant.ts` (Mandant und verifizierte GwG-Prüfung), nie aus dem
Formular.

### Produktentscheidungen

Produktentscheidung (Rey Koxha, 21.10.2026) zu den offenen Fragen aus Stufe 3a,
so wie umgesetzt; keine fachliche Freigabe, die Regel bleibt ungeprüft:

- **Kanzleileitung:** ADMIN und PARTNER mit aktuellem Rollenstand gelten als
  Kanzleileitung (`rol.adm`).
- **Zuständige Berufsträgerin:** Die Zuordnung BERUFSTRAEGER mit aktueller
  Berufsträgereigenschaft gilt als zuständige Berufsträgerin (`bt`), auch für
  §-153-Würdigungen im Tax-CMS.
- **„Nur meine Mandate“:** Der Filter des Portfolios zeigt Mandanten, bei denen
  die Person zuständige Berufsträgerin oder Hauptbearbeitung ist.
- **Rechtsform des Mandantenankers:** aus der verifizierten GwG-Prüfung, ohne
  sie die Art des Mandanten (natürliche bzw. juristische Person).
- **Kontakte ohne Portalzugang:** dürfen Rollen im Tax-CMS erhalten.
  Freigaben, Risikoakzeptanzen, Kenntnisnahmen und die Zielfreigabe der
  Einrichtung adressiert die kanzleikonsole nur an Kontakte mit aktivem
  Portalzugang (`@taxtronik/db/portal-zugang`, dieselbe Regel wie der
  Zustell-Worker); sie prüft das vor jedem Senden, bei der Einrichtung auch
  unmittelbar vor dem Anlegen von Version 1.

## Bekannte Abweichungen und Grenzen

Die Abbildungstabelle ist fachlich nicht freigegeben. Der Zustell-Worker ruft
das Tax-CMS nur als Systemakteur ohne Personen- und Mandantenbezug und nur für
den Postausgang auf (MAIL-OUTBOX-001); eine Bestätigung von Personen ohne
Sitzung gibt es nicht. Alle Bereiche der Oberflächen (Programm und
Dokumentation, Risiken, Kontrollen, Kalender, Prüfung, Länder,
Durchführungen, Feststellungen, Arbeitskorb, Ereignisse, Portal, Audit) nutzen
dieselben Helfer.

## Fachliche Prüffragen

- Die Fragen aus Stufe 3a (Kanzleileitung, zuständige Berufsträgerin,
  Kontaktrollen ohne Portalzugang) sind durch die Produktentscheidung (Rey
  Koxha, 21.10.2026) ersetzt (Umsetzung, Produktentscheidungen).
- Genügt „mindestens einmal im Portal angemeldet“ als Bestätigung der
  Adresse, oder braucht es eine ausdrückliche Bestätigung je Adressänderung?

## Technische Nachweise

`seite.test.ts` belegt Reihenfolge und Bindung der Seiten-Helfer,
`aktion.test.ts` die der Aktions-Helfer, `zustand.test.ts` die festen
Meldungen bei Verweigerung. `namen-personen-db.test.ts` prüft gegen
PostgreSQL Namensauflösung und Personenprüfung, `akteur-db.test.ts` die
Akteursabbildung selbst. `client-page-authz.test.ts` erzwingt den
Zugriffs-Guard als ersten Aufruf auch im Tax-CMS-Helfer. `actions.test.ts`
belegt, dass die Aktionen den gebundenen Mandanten statt Formularwerten
verwenden, `mandant.test.ts` die Bereinigung der Ankerfelder.
