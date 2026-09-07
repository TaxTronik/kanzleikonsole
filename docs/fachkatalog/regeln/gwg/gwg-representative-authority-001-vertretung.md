---
id: GWG-REPRESENTATIVE-AUTHORITY-001
title: Auftretende Person identifizieren und Vertretungsberechtigung prüfen
domain: gwg
rule_type: statute
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    TaxTronik speichert Vertreter mit stabiler Identität und vollständigen
    allgemeinen Personenangaben im Prüfsnapshot, unterstützt Doppelrollen mit
    wirtschaftlich Berechtigten und verlangt bei Rechtsträgern mindestens
    einen bestätigten Ausweis für einen Vertreter. Bei einer ausdrücklich
    verknüpften Doppelrolle kann dies derselbe, über die Owner-ID gebundene
    Personennachweis sein. Die konkrete Vertretungsmacht, der tatsächlich
    Auftretende und Vertreter natürlicher Personen werden jedoch nicht
    vollständig strukturiert geprüft.
sources:
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 1 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 11 Abs. 1 und 4 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 12 Abs. 1 und 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__12.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-model.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-persons.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-overview.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-labels.ts
  - apps/web/src/server/gwg/representatives.ts
  - apps/web/src/server/gwg/verification.ts
  - apps/web/src/server/gwg/identity-subject.ts
  - apps/web/src/server/gwg/revisions.ts
  - apps/web/src/server/gwg-onboarding/representative-submission.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/owner-actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/add-beneficial-owner-role-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/new-gwg-person-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-general-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-roles-panel.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/legal-entity-details-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260801004900_gwg_cross_role_person_identity/migration.sql
  - packages/db/prisma/migrations/20260826010000_gwg_representative_general_person_data/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
  - apps/web/src/server/gwg/__tests__/representatives.test.ts
  - apps/web/src/server/gwg/__tests__/verification.test.ts
  - apps/web/src/server/gwg/__tests__/identity-subject.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/representative-submission.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/gwg-layout.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
related_rules:
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-RISK-REVIEW-001
  - GWG-SELF-ONBOARDING-001
tags:
  - vertreter
  - vertretungsberechtigung
  - auftretende-person
---

# GWG-REPRESENTATIVE-AUTHORITY-001 — Auftretende Person identifizieren und Vertretungsberechtigung prüfen

## Kurzfassung

Handelt für den Vertragspartner eine andere Person, sind deren Identität und
die Berechtigung zum Auftreten zu prüfen. TaxTronik erfasst bei Rechtsträgern
eine geordnete Vertreterliste, kann eine Person zugleich als wirtschaftlich
Berechtigten kennzeichnen und verlangt für die Freigabe mindestens einen
eindeutig zugeordneten, gültigen Vertreter-Ausweis.

Die Software stellt die Vertretungsmacht nicht selbst fest. Insbesondere wird
nicht strukturiert gespeichert, welche Person im konkreten Vorgang tatsächlich
auftritt und auf welcher Register-, Organ- oder Vollmachtsgrundlage sie dazu
berechtigt ist.

## Wann gilt die Regel?

Die Regel gilt, wenn eine Person für einen Vertragspartner gegenüber der Kanzlei
auftritt. Im aktuellen Produktpfad wird sie vor allem für juristische Personen
und Personengesellschaften angewendet. Die bloße Erfassung aller gesetzlichen
Vertreter eines Rechtsträgers ist von der Prüfung der konkret auftretenden
Person zu unterscheiden.

Vertreter einer natürlichen Person können im öffentlichen GwG-Onboarding
derzeit nicht als eigener Fall erfasst werden; dieser Fall bleibt außerhalb des
implementierten Wizard-Schemas.

## Benötigte Angaben

- Vertragspartner und Mandantentyp
- Name und stabile ID der tatsächlich auftretenden Person
- gegebenenfalls Rolle als Organ, gesetzlicher Vertreter, Bevollmächtigter oder
  sonstiger Vertreter
- Identitätsangaben und geeigneter Nachweis der auftretenden Person
- Grundlage und Umfang der Vertretungsberechtigung
- Register- oder Gründungsunterlagen beziehungsweise Vollmachtsnachweis
- gegebenenfalls ausdrückliche Doppelrolle als wirtschaftlich Berechtigter

## Entscheidungslogik

| Wenn                                                                            | Dann                                                                            | Begründung                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Rechtsträger ohne erfassten Vertreter                                           | Freigabe blockieren                                                             | Vertretungsorgan/gesetzliche Vertretung fehlt im Snapshot |
| Separater Vertreter wird im Self-Onboarding angegeben                           | Vollständigen Ausweissatz verlangen                                             | Auftretende Person muss identifiziert werden              |
| Vertreter ist dieselbe Person wie ein erfasster wirtschaftlich Berechtigter     | Explizite ID-Verknüpfung zulassen; vorhandenen Personennachweis wiederverwenden | Doppelrolle ohne Namensheuristik                          |
| Name oder Owner-Verknüpfung eines Vertreters ändert sich                        | Frühere Identitätszuordnung entwerten                                           | Geänderte Personengrundlage darf nicht fortgelten         |
| Mindestens ein Vertreter-Ausweis ist bestätigt und übrige Prüfdaten vollständig | Technisches Freigabegate kann passieren                                         | Mindestnachweis im Produkt erfüllt                        |
| Grundlage oder Umfang der Vertretungsmacht ist unklar                           | Manuelle Prüfung; keine automatische Aussage zur Berechtigung                   | Rechts- und Beweisfrage                                   |

## Ausnahmen und Grenzfälle

- Ein wirtschaftlich Berechtigter kann zugleich gesetzlicher Vertreter sein.
  Die Rollen bleiben fachlich verschieden und werden nur durch eine ausdrückliche
  Referenz verbunden.
- Gleichlautende Namen begründen keine Personenidentität.
- Gesamtvertretung, Prokura, Untervollmacht, Beschränkungen im Innenverhältnis
  und ausländische Vertretungsregeln sind nicht als Entscheidungsmodell
  implementiert.
- Das Freigabegate verlangt einen bestätigten Vertreter-Ausweis, aber nicht
  zwingend einen strukturiert verknüpften Vollmachtsbeleg.
- Bei mehreren Vertretern weist das Datenmodell nicht aus, wer im konkreten
  Kanzleikontakt tatsächlich aufgetreten ist.

## Beispiele

### Normalfall

Für eine GmbH wird die Geschäftsführerin als Vertreterin erfasst. Ihr Ausweis
ist exakt ihrer Vertreter-ID zugeordnet; Registerauszug und
Rechtsträgerangaben liegen vor. Der Berufsträger prüft manuell, dass die
Registerlage die Vertretung trägt.

### Grenzfall

Ein Gesellschafter ist wirtschaftlich Berechtigter und soll zugleich als
Vertreter auftreten. Der gleiche Name genügt nicht. Erst die ausdrückliche
Verknüpfung der Vertreter-ID mit dem Berechtigten erlaubt die Wiederverwendung
des Personennachweises; die Vertretungsmacht bleibt gesondert zu prüfen.

## Umsetzung in TaxTronik

Die Staff-Einzelprüfung trennt Stammdaten/Prüfverlauf und Personenanzeige von der Datenprojektion. Gesetzliche Vertretung bleibt vor Einladung und Personenbereich sichtbar; ausdrücklich verbundene Vertreter-/WB-Doppelrollen bleiben zusammengeführt. Die zugrunde liegenden Fachentscheidungen und Bearbeitungssperren abgeschlossener Prüfungen bleiben erhalten.

Vertreter werden als eigene Datensätze mit stabiler UUID, Reihenfolge und
allgemeinen Personenangaben gespeichert. `syncGwgRepresentativesTx`
aktualisiert die Liste konkurrenzsicher; Änderungen an identitätsrelevanten
allgemeinen Angaben oder der Doppelrollen-Verknüpfung entwerten zugeordnete
Identitätsdokumente. Der Self-Onboarding-Pfad verlangt für einen separaten
Vertreter einen vollständigen Ausweissatz.

Das zentrale Freigabegate akzeptiert eine bestätigte Ausweiszuordnung zu einer
Vertreter-ID desselben Prüfsnapshots. Bei einer ausdrücklich über
`linkedBeneficialOwnerId` verknüpften Doppelrolle akzeptiert es alternativ den
bestätigten Ausweis genau dieser Owner-ID. Die Owner-ID muss zu einem im selben
Snapshot erfassten wirtschaftlich Berechtigten gehören; bloße Namensgleichheit
bleibt ausgeschlossen. Die allgemeinen Personendaten werden in diesem Fall aus
dem ausdrücklich verknüpften Owner-Snapshot bewertet. Dadurch blockiert ein
älterer, noch unvollständiger Vertretersnapshot die gemeinsame Person nicht;
eine fehlende oder fremde Verknüpfung bleibt fail-closed. Register- und Gründungsbelege können die manuelle
Berechtigungsprüfung unterstützen, werden aber nicht semantisch ausgewertet.

Die Staff-Oberfläche zeigt gesetzliche Vertreter als erfasste Personen im
Bereich „Personen“. Neue Vertreter entstehen nur über „Neue Person erfassen“
oder durch das Zuweisen der Vertreterrolle an eine bereits erfasste Person.
Freie Namenszeilen in den Rechtsträgerdaten und in der Rollenpflege gibt es
nicht; auch die Staff-Action weist das frühere Freitextfeld zurück. Jede Person
besitzt den Unterbereich „Allgemeine Angaben“ für Name, Geburtsdaten, Wohnsitz,
Staatsangehörigkeit und PEP-Status. Das Gate verlangt diese Angaben auch für
eine ausschließlich vertretungsberechtigte Person. Der Unterbereich „Rolle(n)“
zeigt die Zuordnung zuerst nur lesend; „Bearbeiten“ ermöglicht die
Rollenänderung und stellt eine Doppelrolle über die stabile Personenreferenz
her. Eine bereits als Vertreter erfasste Person wird ohne erneute Eingabe ihrer
allgemeinen Angaben um die wirtschaftlich-berechtigte Rolle ergänzt; nur der
rollenspezifische Anteil wird erfasst. Beide Rollensnapshots werden atomar
synchronisiert, ohne die Vertreterrolle zu entfernen. Das Herstellen einer
Vertreterrolle aus einem vorhandenen Owner und spätere Owner-Korrekturen
übernehmen dabei Name, Geburtsdatum, Geburtsort, Wohnsitz, Staatsangehörigkeit
und PEP-Status vollständig. Ein bereits auf der Owner-ID gespeicherter Ausweis
wird in der Personenansicht über dieselbe stabile Verknüpfung beim gemeinsamen
Doppelrollen-Eintrag angezeigt. Ein eigener
Stammdaten-Überblick oberhalb von
Stepper und Mandanteneinladung nennt die gesetzlichen Vertreter zusammen mit
den zentralen Rechtsträger- und Registerangaben. Der spätere Abschnitt
„Rechtsträger- und Registernachweise“ enthält nur noch die Dokumentnachweise und
keine zweite Stammdaten- oder Vertreterpflege.

## Bekannte Abweichungen und Grenzen

- Die konkrete Vertretungsberechtigung wird nicht als prüfbares Ergebnis mit
  Rechtsgrund, Umfang und Prüfzeitpunkt gespeichert.
- Der tatsächlich Auftretende ist nicht von der allgemeinen Vertreterliste
  getrennt modelliert.
- Vertreter natürlicher Personen werden im öffentlichen Wizard abgewiesen.
- Eine hochgeladene `VOLLMACHT` wird nicht zwingend einer bestimmten Person und
  einem bestimmten Umfang zugeordnet.
- Registerdaten werden nicht amtlich automatisiert abgeglichen.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Muss der tatsächlich Auftretende je Prüfzyklus ausdrücklich markiert werden?
- Welche Nachweise genügen für Organvertretung, Prokura und rechtsgeschäftliche
  Vollmacht?
- Ist die Prüfung nur eines Vertreters ausreichend, wenn mehrere Personen
  auftreten oder Gesamtvertretung besteht?
- Wie werden Vertreter natürlicher Personen und ausländische Vollmachten
  aufgenommen?

## Technische Nachweise

`page-render.test.tsx`: Der gerenderte Seitentest prüft die Abschnittsreihenfolge und die gemeinsame Vertreter-/WB-Person mit ihrem explizit zugeordneten Ausweis.

Der Synchronisationshelfer und die Datenbankmigration belegen stabile
Vertreteridentitäten, allgemeine Personenangaben, Doppelrollen und das
Entwerten überholter Zuordnungen. Die Tests prüfen Positions- und Rollenwechsel,
die gemeinsame Anlage einer Person mit Vertreter- und
wirtschaftlich-berechtigter Rolle, die spätere atomare Ergänzung der Rolle ohne
erneute Stammdateneingabe, die Synchronisation allgemeiner Angaben, das
Vollständigkeitsgate, separate Ausweissätze, die Wiederverwendung eines
bestätigten Owner-Ausweises bei explizit verknüpfter Doppelrolle, unbekannte
Doppelrollen, ältere unvollständige Vertretersnapshots, die gemeinsame
Ausweisanzeige und den Schutz vor Namensheuristik. Sie belegen nicht die
materielle Vertretungsmacht.
