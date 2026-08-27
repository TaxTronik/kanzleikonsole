---
id: GWG-IDENTIFICATION-EVIDENCE-001
title: Identitätsangaben erheben und mit zugeordnetem Nachweis prüfen
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
    TaxTronik erfasst natürliche Personen und Rechtsträger strukturiert, bindet
    eingescannte Nachweise an eine konkrete Person und verlangt für die
    Freigabe verfügbare, virengeprüfte Belege. In einem bearbeitbaren Snapshot
    können Ausweissätze und Rechtsträgernachweise atomar durch neue Belege
    ersetzt werden. Abgelöste Zuordnungen bleiben als Alt-Nachweise sichtbar;
    irrtümliche Zuordnungen können gelöst werden, ohne Dokument oder
    Dateiversionen aus der Mandantenakte zu löschen. Ein Ausweissatz ist auf
    höchstens zwei Dateien begrenzt; je Person darf nur ein Ausweissatz aktiv
    sein.
    Unterstützt werden jedoch nur ausgewählte Nachweisarten; Echtheit, amtliche
    Registerdaten und alternative elektronische Identifizierungsverfahren
    werden nicht selbst verifiziert.
sources:
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 1 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 11 Abs. 1, 3 und 4 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 12 Abs. 1 und 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__12.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 8 Abs. 1 bis 3 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__8.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/gwg/verification.ts
  - apps/web/src/server/gwg/evidence-documents.ts
  - apps/web/src/server/gwg/identity-subject.ts
  - apps/web/src/server/gwg/revisions.ts
  - apps/web/src/server/gwg-onboarding/identity-persistence.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/_action-helpers.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/add-id-doc-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/evidence-form-toggle.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/identity-document-review.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/new-gwg-person-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-general-form.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-roles-panel.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/evidence-view-state.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/remove-evidence-link-button.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/select-current-identity-set-button.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/owner-actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
  - apps/web/src/server/gwg/representatives.ts
  - apps/web/src/server/gwg/reverification.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260801004300_gwg_identity_subjects_and_document_sets/migration.sql
  - packages/db/prisma/migrations/20260824213000_gwg_evidence_supersession/migration.sql
  - packages/db/prisma/migrations/20260826010000_gwg_representative_general_person_data/migration.sql
test_refs:
  - apps/web/src/server/gwg/__tests__/verification.test.ts
  - apps/web/src/server/gwg/__tests__/representatives.test.ts
  - apps/web/src/server/gwg/__tests__/reverification.test.ts
  - apps/web/src/server/gwg/__tests__/evidence-documents.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/evidence-view-state.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/gwg-layout.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
  - docs/anwenderdoku/dokumente.md
related_rules:
  - GWG-ACTIVATION-GATE-001
  - GWG-REPRESENTATIVE-AUTHORITY-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-SELF-ONBOARDING-001
  - GWG-RETENTION-DESTRUCTION-001
tags:
  - identifizierung
  - identitaetsnachweis
  - ausweis
  - register
---

# GWG-IDENTIFICATION-EVIDENCE-001 — Identitätsangaben erheben und mit zugeordnetem Nachweis prüfen

## Kurzfassung

Vor der Produktfreigabe müssen die für den Mandantentyp vorgesehenen
Identitätsangaben gespeichert und mit einem konkreten Nachweis verbunden sein.
Bei natürlichen Personen akzeptiert das aktuelle Gate einen gültigen
Personalausweis oder Reisepass; bei Rechtsträgern werden Rechtsform,
Registerdaten beziehungsweise Registerlosigkeit und ein Register- oder
Gründungsnachweis verlangt.

Die Software prüft Struktur, Zuordnung, Gültigkeitsdatum, Verfügbarkeit und
Virenscanstatus. Sie stellt weder die Echtheit eines Dokuments noch die
inhaltliche Richtigkeit einer amtlichen Quelle selbst fest.

## Wann gilt die Regel?

Die Regel gilt bei der Erstidentifizierung, bei Zweifeln an früher erhobenen
Angaben und bei einem neuen Prüfzyklus, der eine erneute Identitätsbestätigung
verlangt. Sie beschreibt die in TaxTronik unterstützten Nachweiswege für
Mandanten, auftretende Vertreter und Rechtsträger.

Andere gesetzlich zugelassene Verfahren wie elektronischer Identitätsnachweis,
qualifizierte elektronische Signatur oder weitere durch Rechtsverordnung
bestimmte Dokumente sind nicht Teil des automatischen Freigabegates.

## Benötigte Angaben

- konkrete zu identifizierende Person und ihre Rolle
- bei natürlicher Person Name, Geburtsort, Geburtsdatum, Staatsangehörigkeit
  und Wohnanschrift
- bei Rechtsträger Firma/Bezeichnung, Rechtsform, Sitz, Registernummer und
  Register/Registergericht, soweit vorhanden
- Dokumenttyp, Dokumentnummer, ausstellende Behörde oder Staat,
  Ausstellungsdatum und Gültigkeitsdatum
- konkrete Datei oder Dateien des Nachweises
- eindeutige Zuordnung zum Mandanten, wirtschaftlich Berechtigten oder Vertreter
- Zeitpunkt und Mitarbeiter der Identitätszuordnungsbestätigung
- Scanstatus und Verfügbarkeit der neuesten Dokumentversion

## Entscheidungslogik

| Wenn                                                                                         | Dann                                                                                                          | Begründung                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Natürliche Person ohne eindeutig zugeordneten gültigen Ausweissatz                           | Freigabe blockieren                                                                                           | Identität ist im Produkt nicht hinreichend belegt    |
| Ausweissatz ist abgelaufen, unvollständig oder widersprüchlich                               | Freigabe blockieren                                                                                           | Nachweisgrundlage ist nicht belastbar                |
| Datei gehört zu anderem Mandanten, ist gelöscht, in Vernichtung oder nicht `GWG_EVIDENCE`    | Nicht als Nachweis werten                                                                                     | Mandanten- und Zweckbindung                          |
| Neueste Datei ist nicht vollständig virengeprüft und `CLEAN`                                 | Nicht als verfügbaren Nachweis werten                                                                         | Unsicherer Upload wird nicht freigabetragend         |
| Rechtsträger mit Registereintrag ohne Register- oder Gründungsnachweis                       | Freigabe blockieren                                                                                           | Unterstützter Rechtsträgernachweis fehlt             |
| Rechtsträger ohne Registereintrag mit dokumentierter Registerlosigkeit und Gründungsnachweis | Nachweis kann in die Prüfung eingehen                                                                         | Unterstützter Alternativfall                         |
| Mitarbeiter bestätigt Personenzuordnung und prüft den Inhalt                                 | `verifiedAt` und Zuordnungsnachweis können gesetzt werden                                                     | Menschliche Prüfung bleibt erforderlich              |
| Bearbeitbarer Snapshot enthält einen überholten Ausweis- oder Rechtsträgernachweis           | Bisherige Zuordnung als abgelöst markieren, neuen sauberen Beleg aktivieren und Alt-Nachweis einsehbar halten | Aktuelle Prüfgrundlage mit nachvollziehbarem Verlauf |
| Ein Ausweissatz enthält mehr als zwei Dateien                                                | Anlage, Ergänzung und Freigabe blockieren                                                                     | Nur Vorder- und Rückseite gehören zum aktiven Satz   |
| Einer Person sind mehrere aktive Ausweissätze zugeordnet                                     | Freigabe blockieren; bei Neuerfassung alle bisherigen aktiven Sätze dieser Person ablösen                     | Pro Person gibt es nur eine aktuelle Prüfgrundlage   |
| Ein Aktenbeleg wurde irrtümlich der Prüfung zugeordnet                                       | Nur die aktive GwG-Zuordnung lösen; Dokument und Dateiversionen in der Mandantenakte erhalten                 | Korrektur ohne vorzeitige Aktenlöschung              |

## Ausnahmen und Grenzfälle

- § 11 Abs. 3 GwG erlaubt unter Voraussetzungen, von einer erneuten
  Identifizierung abzusehen. TaxTronik kopiert bei Re-Verifikation eine
  Arbeitsgrundlage, verlangt aber für den neuen Zyklus eine neue Bestätigung.
- Ein Ausweis ist am gespeicherten Ablaufdatum noch gültig; die Prüfung arbeitet
  mit Kalendertagen.
- Vorder- und Rückseite müssen zu einem stabilen `documentSetId` gehören und
  dieselben Metadaten tragen. Ein aktiver Satz besteht aus höchstens zwei
  Dateien. Pro Person darf nur eine `documentSetId` aktiv sein; Personalausweis
  und Reisepass bilden deshalb keine parallelen aktiven Prüfgrundlagen.
  Mehrere unterschiedliche Dokumente dürfen nicht heuristisch anhand des
  Namens zusammengeführt werden.
- Ein identischer Name belegt keine identische Person. Rollen werden über
  Fremdschlüssel, nicht über Namensvergleich, verbunden.
- Bei ausländischen Dokumenten und nicht standardisierten Registern ist eine
  manuelle Eignungs- und Echtheitsprüfung nötig.

## Beispiele

### Normalfall

Eine natürliche Person lädt Vorder- und Rückseite ihres Personalausweises hoch.
Beide Dateien gehören demselben Ausweissatz, sind demselben Mandanten
zugeordnet, vollständig gescannt und am Prüftag gültig. Ein Mitarbeiter
bestätigt die Zuordnung; der Nachweis kann das Freigabegate passieren.

### Grenzfall

Ein Reisepass wurde als saubere Datei gespeichert, ist aber nur anhand eines
gleichlautenden Namens einem Vertreter zugeordnet. Ohne bestätigten
Vertreter-Fremdschlüssel wird er nicht als Identitätsnachweis akzeptiert.

## Umsetzung in TaxTronik

`verification.ts` bildet das serverseitige Freigabegate. Personalausweis- und
Reisepassdateien werden nach `documentSetId` gruppiert, auf konsistente
Metadaten, genau eine Rollenreferenz, Bestätigung, Gültigkeit und einen sauberen
Dateinachweis geprüft. Die Datenbank ergänzt Eindeutigkeits- und
Integritätsregeln.

Für Rechtsträger verlangt das Gate gespeicherte Rechtsträgerdaten und je nach
Registerstatus einen Registerauszug oder ein beweiskräftiges
Gründungsdokument. Die eigentliche fachliche Sichtprüfung und Bestätigung
erfolgt durch Mitarbeiter beziehungsweise den entscheidenden Berufsträger.

Die Staff-Oberfläche ersetzt Nachweise ausschließlich in einem bearbeitbaren
Prüfsnapshot. Bei einem neuen Ausweis werden alle bisherigen aktiven
Personalausweis- und Reisepass-Sätze derselben, über Fremdschlüssel bestimmten
Person abgelöst. Eine aus einem konkreten Satz gestartete Ersetzung bindet die
Anfrage zusätzlich an diesen noch aktiven Ausgangssatz. Bei
Rechtsträgernachweisen werden die bisherigen Zuordnungen desselben Typs
abgelöst. Jeder Register-Nachweistyp besitzt dafür einen eigenen, zunächst
geschlossenen Bereich „Nachweis hinzufügen“ beziehungsweise „Nachweis
ersetzen“. Das darin liegende Formular ist fest an den Typ des äußeren
Expandables gebunden; in „Handelsregisterauszug“ kann daher kein
Transparenzregisterauszug erfasst werden. Bereits vorhandene parallele aktive
Ausweissätze blockieren das Freigabegate und werden in der Personenübersicht
ausdrücklich angezeigt. Ein
Mitarbeiter muss einen der vorhandenen Sätze bewusst als aktuell festlegen;
erst dann werden die übrigen Sätze als alte Nachweise abgelöst.
Abgelöste `GwgIdDocument`-Zeilen bleiben mit Zeitstempel erhalten,
werden im jeweiligen Expandable unter „Alte Nachweise“ angezeigt und vom
aktuellen Freigabegate sowie von der Kopie in einen neuen Prüfzyklus ignoriert.
Die neuen Dateien müssen verfügbare, vollständig gescannte
`GWG_EVIDENCE`-Belege desselben Mandanten sein.

Das X an einem aktiven Nachweis löscht ausschließlich dessen
`GwgIdDocument`-Zuordnung. Das zugehörige `Document`, seine unveränderlichen
Versionen und die Ablage beim Mandanten werden nicht gelöscht. Wird eine Seite
eines Ausweissatzes gelöst, werden verbleibende Seiten entbestätigt. Anlage,
Ergänzung und Gate begrenzen einen aktiven Ausweissatz serverseitig auf zwei
Dateien; die Oberfläche spiegelt dieselbe Grenze.

Die Personenübersicht unterscheidet einen vorhandenen, aber vollständig
abgelaufenen aktiven Ausweissatz ausdrücklich von einem fehlenden Nachweis.
Sie beginnt mit „Neue Person erfassen“ und zeigt anschließend jede erfasste
Person als eigenes Expandable. Darin steht „Allgemeine Angaben“ vor dem
Identitätsnachweis und erfasst die identitätsrelevanten Personendaten unabhängig
von ihrer Rolle. Änderungen an diesen Daten gelten für alle verknüpften Rollen
und entwerten die bisherige Identitätsbestätigung. Der Unterbereich
„Personalausweis“ startet im Lesemodus mit den gespeicherten Dokumentdaten. Erst
„Bearbeiten“ öffnet die Änderungs- und Upload-Funktionen; der gesonderte Button
„Ausweis ersetzen“
öffnet den Austausch eines vorhandenen Satzes direkt. Abgelöste Ausweise liegen
eingeklappt innerhalb desselben Unterbereichs „Personalausweis“ und nicht mehr
als gleichrangiges Element neben ihm. Ein fehlender Ausweis wird erst im
Bearbeitungsmodus neu erfasst. Der danebenliegende Unterbereich
„Rolle(n)“ folgt derselben Trennung zwischen Lese- und Bearbeitungsmodus.
Für die Aktiv-/Alt-Anzeige gelten sowohl ein nicht gesetztes
`supersededAt`-Feld als auch `NULL` als aktiv; nur ein vorhandener Zeitstempel
kennzeichnet einen Alt-Nachweis. Dadurch bleibt die Einordnung auch während
eines Rolling Deployments mit einem noch alten Prozess fail-safe.

## Bekannte Abweichungen und Grenzen

- Elektronischer Identitätsnachweis, qualifizierte elektronische Signatur,
  notifizierte eID-Systeme und weitere zulässige Dokumentwege werden nicht als
  strukturierter Verifikationsweg unterstützt.
- TaxTronik führt keine Ausweis-Echtheitsprüfung und keinen automatischen
  Abgleich mit amtlichen Registern durch.
- `CLEAN` bestätigt ausschließlich den technischen Virenscan, nicht die
  Identität oder Dokumentechtheit.
- Die Oberfläche erfasst nicht für jede zulässige Dokumentart alle besonderen
  Aufzeichnungspflichten aus § 8 Abs. 2 GwG.
- Eine Kopie kann gespeichert werden; ob der konkrete Nachweis im Einzelfall
  geeignet und ausreichend ist, bleibt eine manuelle Fachentscheidung.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Genügen die unterstützten Dokumentarten für den tatsächlichen Mandantenkreis?
- Welche alternativen Identifizierungsverfahren sollen ergänzt werden?
- Wer darf die Identitätszuordnung bestätigen und welche Vier-Augen-Kontrolle
  ist erforderlich?
- Müssen ausländische Dokumente oder Registerquellen mit zusätzlichen
  Prüfschritten gekennzeichnet werden?
- Ist das erneute Bestätigen eines übernommenen Nachweises im jeweiligen Risiko
  ausreichend?

## Technische Nachweise

Die Verifikations- und Evidence-Helfer belegen das fail-closed Gate für
Personenzuordnung, Dateiverfügbarkeit und Dokumentgruppen. Die Tests prüfen
fremde, gelöschte, falsch klassifizierte, noch nicht sauber gescannte,
abgelaufene und widersprüchliche Nachweise sowie stabile Vorder-/Rückseiten-
Gruppen. Action- und Strukturtests belegen zusätzlich die zentrale Erfassung
allgemeiner Personenangaben, ihre Synchronisation bei Doppelrollen, die
Entwertung einer Identitätsbestätigung nach identitätsrelevanten Änderungen und den atomaren Austausch
aller aktiven Ausweissätze einer Person mit sichtbarer Alt-Zuordnung, die
Ein-Satz-pro-Person- und Zwei-Dateien-Grenze, das ausschließliche Lösen einer
Fehlzuordnung bei Erhalt des Aktenobjekts sowie die Bedienoberfläche und deren
getrennte Lese- und Bearbeitungsmodi. Die View-State-Tests sichern zusätzlich
die Trennung von fehlend, abgelaufen, mehrfach und gültig sowie die
Aktiv-Einordnung eines noch nicht projizierten Supersession-Felds. Nicht
nachgewiesen werden Echtheit oder fachliche Eignung des Originaldokuments.
