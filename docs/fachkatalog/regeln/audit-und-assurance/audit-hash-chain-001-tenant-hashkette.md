---
id: AUDIT-HASH-CHAIN-001
title: Audit-Ereignisse je Kanzlei-Tenant kanonisch verketten
domain: audit-und-assurance
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Der Evidence-Service bildet pro Kanzlei-Tenant eine serialisierte SHA-256-Kette über kanonische Audit-Ereignisse und prüft sie mit derselben Abbildung nach.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, Mechanik der Hash-Kette
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: ADR 0004, Manipulationsevidenz durch Hash-Kette und RFC 3161
    path: docs/adr/0004-evidence-chain-mit-rfc3161.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/admin/audit/page.tsx
  - packages/evidence/src/service.ts
  - packages/evidence/src/chain.ts
  - packages/evidence/src/canonical-json.ts
  - apps/web/src/server/audit/query.ts
  - apps/web/src/app/api/staff/admin/audit/export/route.ts
  - apps/worker/src/jobs/portal-inbox-cleanup.ts
  - apps/web/src/server/inbox/attachment-delivery.ts
  - apps/web/src/server/inbox/client-notification.ts
  - apps/web/src/server/auth/webauthn.ts
  - apps/web/src/server/auth/admin-break-glass.ts
  - apps/web/scripts/reset-admin-password.ts
  - apps/web/src/app/staff/(protected)/profile/actions.ts
  - apps/web/src/app/staff/(protected)/admin/users/actions.ts
  - packages/db/prisma/migrations/20260903010000_staff_security_reset_credential_revocation/migration.sql
test_refs:
  - packages/evidence/src/__tests__/service-record.test.ts
  - packages/evidence/src/__tests__/hash-chain.test.ts
  - packages/evidence/src/__tests__/canonical-json.property.test.ts
  - apps/web/src/server/audit/__tests__/query.test.ts
  - apps/web/src/app/api/staff/admin/audit/export/__tests__/route.test.ts
  - apps/worker/src/jobs/__tests__/portal-inbox-cleanup.test.ts
  - apps/web/src/server/inbox/__tests__/attachment-delivery.test.ts
  - apps/web/src/server/inbox/__tests__/client-notification.test.ts
  - apps/web/src/app/staff/(protected)/profile/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/admin/users/__tests__/account-actions.test.ts
  - apps/web/src/server/auth/__tests__/webauthn.test.ts
  - apps/web/src/server/auth/__tests__/admin-break-glass.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/adr/0004-evidence-chain-mit-rfc3161.md
related_rules:
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-VERIFY-ALERT-001
  - AUDIT-ARCHIVE-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - audit
  - hashkette
  - manipulationsevidenz
---

# AUDIT-HASH-CHAIN-001 — Audit-Ereignisse je Kanzlei-Tenant kanonisch verketten

## Kurzfassung

TaxTronik schreibt über den Evidence-Service Audit-Ereignisse in eine eigene
Kette je Kanzlei-Tenant. Jeder Kettenwert bindet den Vorgänger und eine
deterministisch kanonisierte Darstellung von Zeitpunkt, Tenant, Akteur, Aktion,
Ressource sowie Vorher- und Nachherzustand. Schreiben und spätere Prüfung
verwenden dieselbe Hash-Abbildung.

## Wann gilt die Regel?

Die Regel gilt, wenn ein fachlicher oder administrativer Schreibpfad den
`EvidenceService.record()` innerhalb seiner Datenbanktransaktion aufruft. Sie
beschreibt die Integrität der so aufgezeichneten Ereignisse. Sie beweist nicht,
dass jeder denkbare Schreibpfad bereits ein Audit-Ereignis erzeugt.

## Benötigte Angaben

- ID des Kanzlei-Tenants (`tenantId`), nicht die ID eines Mandanten/Clients
- Akteurtyp und, soweit vorhanden, Akteur-ID
- Aktionskennung
- Ressourcentyp und Ressourcen-ID
- optionaler Vorher- und Nachherzustand
- Ereigniszeitpunkt oder der vom Service gesetzte aktuelle Zeitpunkt
- letzter Kettenwert desselben Kanzlei-Tenants

## Entscheidungslogik

| Ausgangslage                                       | Ergebnis                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Erstes Ereignis eines Kanzlei-Tenants              | tenantspezifischen Genesis-Wert als Vorgänger verwenden          |
| Vorgänger existiert                                | dessen `thisHash` als `prevHash` des neuen Ereignisses binden    |
| Zwei Schreiber desselben Kanzlei-Tenants           | per transaktionsgebundenem Advisory Lock serialisieren           |
| Objekt enthält unterschiedlich sortierte Schlüssel | Schlüssel kanonisch sortieren und identisch serialisieren        |
| Nicht endliche Zahl oder nicht unterstützter Wert  | Kanonisierung ablehnen statt einen mehrdeutigen Hash zu erzeugen |
| Nachrechnung weicht ab                             | Kettenprüfung als fehlerhaft melden                              |

## Ausnahmen und Grenzfälle

`BigInt` wird als Dezimaltext, binäre Daten werden hexadezimal und Datumswerte
werden als ISO-Zeitpunkt kanonisiert. IP-Adresse und User-Agent können am
Audit-Datensatz stehen, gehören aber bewusst nicht zum gehashten Ereignis.
Ereignisse verschiedener Kanzlei-Tenants bilden getrennte Ketten.

## Beispiele

### Normalfall

Eine Rechnung wird in einer Tenant-Transaktion versendet. Derselbe
Transaktionsclient schreibt `invoice.send`; der neue Audit-Wert bindet die
vorherige Spitze dieses Kanzlei-Tenants und den Statuswechsel.

### Grenzfall

Zwei Transaktionen wollen gleichzeitig Audit-Ereignisse für denselben
Kanzlei-Tenant schreiben. Der Advisory Lock ordnet beide Inserts, sodass genau
eine lineare Vorgängerfolge entsteht.

## Umsetzung in TaxTronik

`service.ts` setzt Zeitpunkt und Vorgänger unter dem Tenant-Lock und schreibt
den Audit-Datensatz. `canonical-json.ts` normalisiert den Ereignisinhalt;
`chain.ts` berechnet Genesis- und Folgewerte. Die Verifikation rekonstruiert
dieselbe Ereignisform aus den gespeicherten Spalten.

Inbox-Call-Sites sollen technische Ressourcen-IDs, Statusmerkmale und Zähler
protokollieren, jedoch keine Nachrichtentexte, Betreffe, Originaldateinamen,
Mandantennamen, Suchbegriffe, Scannerdiagnosen oder freien Ablehnungstexte.
Der Cleanup eines nie abgesendeten, abgelaufenen PENDING-Intents ohne
auffindbare Bytes löscht Intent und schreibt seinen technischen Reason-Code in
derselben Tenant-`SYSTEM`-Transaktion; ein Auditfehler rollt die Löschung zurück.
DB-Trigger schützen Zustandsinvarianten, ersetzen aber kein erfolgreich
gekoppeltes Auditereignis im fachlichen Schreibpfad.

Der ADMIN-Owner-CLI-Reset koppelt Passwort-/TOTP-Rücksetzung,
Credential-Widerruf, Auth-Revision und das tenantgebundene
`staff.hardware_access.reset` in derselben Transaktion; ohne angemeldete
Anwendungssitzung ist der Akteur dabei `SYSTEM`. Die exklusive, symlinksichere
Recovery-Datei muss nach dem Audit-Write, aber noch vor dem Commit vollständig
und dauerhaft geschrieben sein. Das Klartextpasswort wird ausschließlich in
diese Datei geschrieben und nicht auf Standardausgabe, Standardfehler oder in
Anwendungslogs ausgegeben. Fehler entfernen nur eine in diesem Lauf teilweise
erzeugte Datei; Datei und auf POSIX-Systemen ihr Elternverzeichnis werden vor
Commit synchronisiert. Ein Ausgabefehler rollt Audit und Reset gemeinsam
zurück. Scheitert erst der Datenbank-Commit, kann eine bereits persistierte,
aber unwirksame Recovery-Datei zurückbleiben und muss betrieblich bereinigt
werden. Abgewiesene Logins mit einem
bekannten Hardware-Credential schreiben ein generisches tenantgebundenes
`auth.login.failure`, ohne Credential-ID, AAGUID, E-Mail oder internes
Prüfdetail. Bei unbekanntem Credential ist kein Tenant belastbar bestimmbar und
es entsteht bewusst kein Ereignis.

Die reguläre administrative Passwort- und TOTP-Rücksetzung widerruft unter
den gemeinsamen Actor-/Target-Kontolocks auch aktive, derzeit ruhende
Hardware-Credentials und bindet die Ausführung an die Auth-Revision der
signierten Actor-Sitzung. Die Audit-Nachzustände von `staff.password.reset`
und `staff.totp.reset` enthalten die Zahl der dabei widerrufenen Credentials;
die selbständige Passwortänderung protokolliert denselben technischen Zähler.

Die zentrale ADMIN/PARTNER-Ansicht und ihr CSV-Export können die unveränderten
Ereignisse nach fachlichen Bereichen filtern und in auf- oder absteigender
Audit-ID-Folge anzeigen. Die Bereiche sind eine Leseprojektion der bekannten
Aktionskennungen; unbekannte historische Kennungen bleiben unter „Sonstige“
sichtbar. Ein GwG-Filter ist keine Behauptung, alle rechtlich relevanten Vorgänge
zu erfassen, insbesondere nicht generische Dokumentzugriffe. Anzeige und Export
verwenden denselben Filter und Berliner Tagesgrenzen, mit exklusiver oberer
Mitternachtsgrenze. Der Prüfstatus betrifft weiterhin die vollständige
Kanzleikette; ein gefilterter CSV-Auszug ist kein lückenloses Kettenarchiv.

## Bekannte Abweichungen und Grenzen

Die Hash-Kette macht nachträgliche Änderungen oder Lücken innerhalb der
aufgezeichneten Folge erkennbar, verhindert aber nicht, dass ein nicht
instrumentierter Fachpfad ohne Audit-Ereignis schreibt. Vollständigkeit braucht
daher zusätzliche Call-Site- und Prozesskontrollen. Ohne einen späteren externen
Anker ist eine vollständig neu erzeugte lokale Historie nicht allein durch
diese Regel von einer ursprünglichen Historie unterscheidbar.
Der `SYSTEM`-Akteur des Owner-CLI-Resets identifiziert den ausgeführten Prozess,
nicht die natürliche Person am Host; dafür bleiben betriebliche Zugriffs- und
Ausführungsnachweise erforderlich.

## Fachliche Prüffragen

- Welche Aktionen müssen zwingend in der Audit-Kette erscheinen?
- Ist der bewusste Ausschluss von IP-Adresse und User-Agent aus dem Hashinhalt
  für den vorgesehenen Nachweisumfang richtig?
- Welche Kontrollen belegen die Vollständigkeit aller relevanten Schreibpfade?
- Reicht die Trennung nach Kanzlei-Tenant für den vorgesehenen Prüfungsumfang
  aus?

## Technische Nachweise

Die Service- und Hash-Ketten-Tests prüfen Vorgängerbindung, Tenant-Serialisierung
und Brucherkennung. Property-Tests variieren Schlüsselreihenfolgen und
unterstützte Werttypen, damit Aufzeichnung und Nachrechnung dieselbe kanonische
Darstellung verwenden.

`admin-break-glass.test.ts` belegt, dass der ADMIN-Owner-Reset das Audit vor
der Credential-Ausgabe schreibt, erst danach committen darf und bei einem
Ausgabefehler die gemeinsame Transaktion zurückrollt. Die Dateitests belegen
zusätzlich exklusives Erstellen, Symlink-Sperre, POSIX-Modus `0600`, das
Ausbleiben einer Klartextausgabe, gezielte Teil-Datei-Bereinigung sowie die
Synchronisierung von Datei und POSIX-Elternverzeichnis. Die Profil- und
Admin-Action-Tests belegen die Audit-Zähler für Widerrufe bei regulären
Passwort-/TOTP-Sicherheitsresets.
