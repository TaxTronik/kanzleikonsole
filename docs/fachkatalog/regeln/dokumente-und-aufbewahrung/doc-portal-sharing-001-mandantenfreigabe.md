---
id: DOC-PORTAL-SHARING-001
title: Dokumente im Portal nur nach ausdrücklicher Mandantenfreigabe ausliefern
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Mandatsorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Portal-Download und -Vorschau verlangen Session-Mandant, explizite
    Freigabe, nicht gelöschtes Dokument und eine saubere finalisierte neueste Version; unsichere
    Dateitypen werden nicht inline auf der App-Origin gerendert.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Dokumente, Freigabe und Mandantenportal
    path: docs/anwenderdoku/dokumente.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Dokumentenarchiv, Zugriff und Auslieferung
    path: docs/development/module/dokumentenarchiv.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/documents/delivery-readiness.ts
  - apps/web/src/server/documents/delivery.ts
  - packages/db/prisma/migrations/20260831190000_document_payroll_access/migration.sql
  - apps/web/src/app/api/portal/documents/[id]/download/route.ts
  - apps/web/src/app/api/portal/documents/[id]/preview-url/route.ts
  - apps/web/src/app/staff/(protected)/documents/actions.ts
  - apps/web/src/server/storage/preview-mime.ts
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/web/src/server/inbox/attachment-delivery.ts
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
  - packages/db/prisma/migrations/20260901006000_portal_inbox_resume_and_routing/migration.sql
test_refs:
  - apps/web/src/server/documents/__tests__/delivery.test.ts
  - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
  - apps/web/src/server/storage/__tests__/preview-mime.test.ts
  - apps/web/src/components/__tests__/document-preview-security.test.ts
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - apps/web/src/server/inbox/__tests__/accept-attachment.test.ts
  - apps/web/src/server/inbox/__tests__/attachment-delivery.test.ts
feature_refs:
  - docs/anwenderdoku/dokumente.md
related_rules:
  - ACCESS-STAFF-PERMISSION-001
  - DOC-VERSION-IMMUTABILITY-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - portal
  - freigabe
  - dokumentzugriff
---

# DOC-PORTAL-SHARING-001 — Dokumente im Portal nur nach ausdrücklicher Mandantenfreigabe ausliefern

## Kurzfassung

Ein von Mitarbeitern geführtes Dokument ist im Mandantenportal nur sichtbar
und abrufbar, wenn es dem Session-Mandanten gehört, nicht soft-gelöscht ist
und ausdrücklich freigegeben wurde. Download und Vorschau erzwingen dieselben
Filter. Die technische Freigabe entscheidet nicht, ob eine Herausgabe
fachlich, berufsrechtlich oder datenschutzrechtlich zulässig ist.

## Wann gilt die Regel?

Die Regel gilt für Portal-Downloads und -Vorschauen sowie für das Setzen oder
Zurückziehen der Staff-Freigabe. Kanzleiinterne Dokumente ohne Mandantenbezug
können nicht freigegeben werden. Selbst durch einen Portal-Kontakt hochgeladene
Dateien können in anderen Uploadpfaden als bereits geteilt angelegt werden;
der Abruffilter bleibt gleich.

## Benötigte Angaben

- authentifizierte Portal-Session mit Tenant, Kontakt und Mandant
- Dokument-ID und Mandantenzuordnung
- nicht gesetztes Soft-Delete
- gesetzter Freigabezeitpunkt
- neueste Dokumentversion mit `scanStatus: CLEAN` und vorhandenem `scanCompletedAt`
- gespeicherter und effektiv erkannter MIME-Typ

## Entscheidungslogik

| Wenn                                                                           | Dann                                                   | Begründung                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| keine Portal-Session besteht                                                   | mit 401 ablehnen                                       | Authentifizierung fehlt                                 |
| ID ungültig oder Filter trifft nicht                                           | 404 liefern                                            | keine Existenzinformation über fremde/private Dokumente |
| Mandant, Freigabe, Löschstatus und Abschlussstatus der neuesten Version passen | neueste Version laden und Abruf auditieren             | ausdrücklicher Zugriffsscope                            |
| Staff will kanzleiinternes Dokument freigeben                                  | Aktion blockieren                                      | kein Portal-Empfänger                                   |
| Staff setzt oder entzieht Freigabe                                             | Mandantenzugriff erneut prüfen und Ereignis auditieren | sensible Zustandsänderung                               |
| MIME ist nicht inline-sicher                                                   | `attachment` und `application/octet-stream` erzwingen  | kein aktiver Inhalt auf der App-Origin                  |
| Vorschau ist `text/plain`                                                      | zusätzlich CSP `sandbox` setzen                        | Defense in Depth gegen Sniffing                         |

## Ausnahmen und Grenzfälle

Die Filter schützen nur den technischen Portalzugriff. Sie prüfen nicht, ob
ein Dokument Daten anderer Personen enthält, ob der ausgewählte Kontakt zur
Kenntnisnahme berechtigt ist oder ob eine fachliche Schlusskontrolle erfolgt
ist. Die Freigabe wirkt auf Mandantenebene; eine feinere Freigabe für einzelne
Kontakte ist nicht Bestandteil dieser Regel.

## Beispiele

### Normalfall

Ein Mitarbeiter gibt einen nicht gelöschten Bescheid für den zugeordneten
Mandanten frei. Ein authentifizierter Kontakt dieses Mandanten kann die neueste
Version herunterladen; der Abruf wird protokolliert.

### Grenzfall

Ein Kontakt kennt die UUID eines privaten Dokuments desselben Tenants, das
aber einem anderen Mandanten gehört oder nicht freigegeben ist. Download und
Vorschau liefern 404 und lesen keine Bytes aus dem Object Store.

## Umsetzung in TaxTronik

Der gemeinsame Ladepfad verlangt an der neuesten Version `CLEAN` und einen
vorhandenen Abschlusszeitpunkt. `PENDING`, Fehler-/Quarantänestatus oder ein
fehlender Zeitpunkt führen vor Audit und Storage zu 404. Auch eine frühere
saubere Version öffnet diesen Abruf nicht. Das gilt für Preview-Metadaten und
den separat angefragten Byte-Stream; eine vorher erhaltene Preview-URL umgeht
die erneute Prüfung nicht.

Beide Portal-Routen filtern in der tenantgebundenen Transaktion auf
`clientId`, `deletedAt: null` und `sharedWithClientAt != null`. Die Staff-
Action erlaubt die Freigabe nur nach aktuellem Mandantenzugriff und auditiert
Freigabe sowie Entzug. `preview-mime.ts` normalisiert Typen, begrenzt Inline-
Rendering auf eine Positivliste und setzt sichere Disposition-/CSP-Header.

Neue personalbezogene Archivartefakte können zusätzlich requiresPayrollAccess
tragen. Dieses Merkmal ist nicht nachträglich herabsetzbar. Die allgemeine
Portalfreigabe ist dafür gesperrt; auch Dokumentversionen, Suche und direkte
Dokumentbenachrichtigungen unterliegen der zusätzlichen Datenbankpolicy.
Der allgemeine Download verlangt aktuelle PAYROLL_MANAGE-Rechte. Bestehende
Archive werden nicht rückwirkend umklassifiziert. Eigene Arbeitnehmer- und
Arbeitgeberausgaben verwenden ihre gesonderten Lohnzugänge.

Eine Inbox-Staging-Anlage ist vor der ausdrücklichen Annahme kein `Document`.
Bei Annahme prüft die Datenbank Tenant, Mandant, Hash, Scannerstatus und
Dokumentversion. Die Annahme selbst ist die ausdrückliche Staff-Entscheidung:
Sie verlangt Titel und aktiven Dokumenttyp, leitet Schutzstufe, Storage und
Retention ausschließlich daraus ab und gibt das vollständig persistierte
Dokument anschließend auf Mandantenebene frei. Vor Abschluss der Übernahme
bleibt es privat; abgelehnte oder blockierte Staging-Bytes sind kein
Portal-Dokument und bleiben nicht downloadbar. Zusätzliche Schutzregeln des
gewählten Dokumenttyps, insbesondere für Personalunterlagen, bleiben wirksam.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb des beschriebenen
Mandanten-, Freigabe-, Lösch- und MIME-Filters. Nicht umgesetzt sind eine
kontaktindividuelle Dokumentfreigabe, eine inhaltliche Drittpersonenprüfung,
ein fachliches Freigabeformular und der Nachweis, dass der Empfänger das
Dokument tatsächlich zur Kenntnis genommen hat.

## Fachliche Prüffragen

- Genügt die Freigabe auf Mandantenebene oder werden Kontaktgruppen benötigt?
- Welche fachliche Kontrolle muss vor der Freigabe dokumentiert werden?
- Wie werden Dokumente mit Daten Dritter oder vertraulichen Teilinhalten behandelt?
- Welche Abruf- oder Kenntnisnahmenachweise sind organisatorisch erforderlich?

## Technische Nachweise

Der Portal-Routentest prüft den vollständigen Freigabe-, Mandanten- und
Soft-Delete-Filter für Download und Vorschau sowie 404 ohne Bytezugriff.
Er prüft außerdem unvollständige oder gesperrte neueste Versionen trotz
vorhandenem früherem sauberem Stand, jeweils ohne Audit und Storage-Zugriff.
MIME-Tests belegen Positivliste, Attachment-Fallback und CSP-Sandbox. Die Tests
bewerten keine Dokumentinhalte und keine fachliche Freigabeentscheidung.
