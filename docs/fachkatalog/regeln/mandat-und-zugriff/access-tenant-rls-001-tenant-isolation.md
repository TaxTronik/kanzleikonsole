---
id: ACCESS-TENANT-RLS-001
title: Tenantdaten mit Kontext und erzwungener Row-Level-Security isolieren
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Datenschutzverantwortliche Kanzlei
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Registrierte Tenant-Tabellen werden durch transaktionsgebundenen
    Tenantkontext, eine App-Rolle ohne BYPASSRLS sowie ENABLE/FORCE-RLS und
    Policies isoliert. Ein CI-Gate sucht nach neuen Tabellen ohne diesen
    Backstop; privilegierte Owner-Pfade bleiben gesondert zu kontrollieren.
sources:
  - kind: product_documentation
    citation: ADR 0002 — Doppelte Verteidigung durch RLS und App-Level-Tenancy
    path: docs/adr/0002-rls-und-app-level-tenancy.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Architektur, Tenant-Trennung und Compliance-Mapping
    path: docs/architecture.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. f, Art. 25 und Art. 32 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 203 Abs. 1 Nr. 3, Abs. 3 und 4 StGB
    url: https://www.gesetze-im-internet.de/stgb/__203.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/auth/portal-profiles.ts
  - apps/web/src/app/portal/(protected)/profile-actions.ts
  - apps/web/src/app/portal/(protected)/layout.tsx
  - apps/web/src/app/portal/(protected)/requests/[id]/page.tsx
  - apps/web/src/app/api/portal/logout/route.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/contacts/actions.ts
  - apps/web/src/app/staff/(protected)/clients/onboarding/[id]/actions.ts
  - apps/web/src/server/ical/feed.ts
  - apps/web/src/app/api/portal/ical/[token]/route.ts
  - apps/web/src/server/auth/staff.ts
  - apps/web/src/server/auth/portal.ts
  - apps/web/src/server/auth/portal-session.ts
  - apps/web/src/app/staff/(auth)/login/page.tsx
  - apps/web/src/app/staff/(auth)/login/actions.ts
  - apps/web/src/app/staff/(auth)/login/password/route.ts
  - apps/web/src/server/auth/session-issued-at.ts
  - apps/web/src/server/auth/revocation.ts
  - packages/db/src/tenant-context.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260623000000_iter42_force_rls/migration.sql
  - packages/db/prisma/migrations/20260831100000_tax_registrations/migration.sql
  - packages/db/prisma/migrations/20260831101000_gwg_person_links/migration.sql
  - packages/db/prisma/migrations/20260831150000_smart_mailbox/migration.sql
  - packages/db/prisma/migrations/20260831160000_payroll_intake/migration.sql
  - packages/db/prisma/migrations/20260831190000_document_payroll_access/migration.sql
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
  - packages/db/prisma/migrations/20260901004000_portal_inbox_scope_forward/migration.sql
  - packages/db/prisma/migrations/20260901005000_expansion_tenant_client_pair_guards/migration.sql
  - packages/db/prisma/migrations/20260901006000_portal_inbox_resume_and_routing/migration.sql
  - packages/db/prisma/migrations/20260901007000_portal_inbox_assignee_refresh/migration.sql
  - packages/db/prisma/migrations/20260903000000_staff_hardware_only_access/migration.sql
  - packages/db/prisma/migrations/20260903001000_staff_webauthn_least_privilege/migration.sql
  - packages/db/prisma/migrations/20260903002000_staff_webauthn_hardening/migration.sql
  - packages/db/prisma/migrations/20260903003000_staff_webauthn_recovery_hierarchy/migration.sql
  - packages/db/prisma/migrations/20260903004000_staff_webauthn_recovery_procedure/migration.sql
  - packages/db/prisma/migrations/20260903005000_staff_webauthn_authenticator_version/migration.sql
  - packages/db/prisma/migrations/20260903006000_fido_mds_trust_state/migration.sql
  - packages/db/prisma/migrations/20260903007000_fido_mds_commit_guard/migration.sql
  - packages/db/prisma/migrations/20260903008000_fido_mds_policy_binding/migration.sql
  - packages/db/prisma/migrations/20260903009000_staff_recovery_role_floor/migration.sql
  - packages/db/prisma/migrations/20260903010000_staff_security_reset_credential_revocation/migration.sql
  - apps/web/src/instrumentation.ts
  - apps/web/src/server/auth/staff-account-recovery-lock.ts
  - apps/web/src/server/auth/webauthn.ts
  - apps/web/src/server/auth/admin-break-glass.ts
  - apps/web/scripts/reset-admin-password.ts
  - packages/db/seeds/lib.ts
  - scripts/check-pnpm-supply-chain.sh
  - apps/web/src/app/staff/(protected)/profile/actions.ts
  - apps/web/src/app/staff/(protected)/admin/users/actions.ts
  - packages/db/scripts/verify-rls.ts
test_refs:
  - apps/web/src/server/auth/__tests__/revocation.test.ts
  - apps/web/src/server/auth/__tests__/revocation.redis.test.ts
  - apps/web/src/server/auth/__tests__/portal-profile-session.test.ts
  - apps/web/src/server/auth/__tests__/portal-profiles.test.ts
  - apps/web/src/app/portal/(protected)/profile-actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/contacts/__tests__/ical-identity-revocation.test.ts
  - apps/web/src/app/staff/(auth)/login/__tests__/code-input.test.tsx
  - apps/web/src/app/staff/(auth)/login/__tests__/totp-enrollment.test.ts
  - apps/web/src/server/auth/__tests__/session-renewal.test.ts
  - packages/db/src/__tests__/rls-cross-tenant.test.ts
  - packages/db/src/__tests__/tax-master-data.test.ts
  - packages/db/src/__tests__/gwg-person-links.test.ts
  - packages/db/src/__tests__/mailbox-rls.test.ts
  - packages/db/src/__tests__/payroll-intake.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
  - packages/db/src/__tests__/mandate-assistance-expansion.test.ts
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - packages/db/src/__tests__/staff-webauthn-migration.test.ts
  - packages/db/src/__tests__/staff-webauthn-rls.test.ts
  - apps/web/src/server/auth/__tests__/webauthn.test.ts
  - apps/web/src/server/auth/__tests__/admin-break-glass.test.ts
  - apps/web/src/server/auth/__tests__/staff-auth-state.test.ts
  - apps/web/src/server/auth/__tests__/staff-session-auth-binding.test.ts
  - packages/config/src/__tests__/env-webauthn.test.ts
  - packages/db/src/__tests__/dev-seed-auth-reset.test.ts
  - apps/web/src/server/auth/__tests__/simplewebauthn-crl-hardening.test.ts
  - apps/web/src/lib/__tests__/webauthn-browser-error.test.ts
  - apps/web/src/app/staff/(protected)/profile/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/admin/users/__tests__/account-actions.test.ts
feature_refs:
  - docs/architecture.md
  - docs/adr/0002-rls-und-app-level-tenancy.md
  - docs/development/module/zugriffsschutz.md
  - docs/operations/fido-mds.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-STAFF-PERMISSION-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
  - ACCESS-SEARCH-SCOPE-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - rls
  - tenant-isolation
  - defense-in-depth
---

# ACCESS-TENANT-RLS-001 — Tenantdaten mit Kontext und erzwungener Row-Level-Security isolieren

## Kurzfassung

Anwendungszugriffe auf Tenantdaten laufen in einer Transaktion mit gesetztem
Tenant-, Akteur- und Akteurtyp-Kontext. PostgreSQL erzwingt auf den erfassten
Tabellen Row-Level-Security auch für den Tabellenowner der App-Rolle. Die
Schicht ist ein technischer Backstop gegen Cross-Tenant-Zugriffe, kein Ersatz
für Objektberechtigungen innerhalb einer Kanzlei.

## Wann gilt die Regel?

Die Regel gilt für die Rolle `taxtronik_app` und alle nicht ausdrücklich
ausgenommenen Tabellen im öffentlichen Schema. Owner-Verbindungen für
Migration, Setup und ausgewählte Systemprozesse können RLS umgehen und fallen
nicht allein unter diesen Schutz.

## Benötigte Angaben

- Tenant-ID
- Akteur-ID oder Systemkontext
- Akteurtyp STAFF, CLIENT_CONTACT oder SYSTEM
- App-Datenbankrolle ohne BYPASSRLS
- ENABLE/FORCE-RLS und mindestens eine Policy je geschützter Tabelle
- zusätzliche Parent-/Tenant-Paar-Constraints bei clientgebundenen Tabellen

## Entscheidungslogik

| Wenn                                                      | Dann                                                     | Begründung                                           |
| --------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| App-Zugriff startet                                       | Transaktion öffnen und Kontext lokal setzen              | Sessionvariablen dürfen nicht verbindungsweit leaken |
| Kontext fehlt oder Tenant stimmt nicht                    | Zeile nicht sichtbar beziehungsweise Mutation blockieren | fail-closed Tenantgrenze                             |
| Tabelle trägt Mandantendaten                              | ENABLE und FORCE RLS plus Policy verlangen               | DB-Backstop                                          |
| neue Tabelle erfüllt Gate nicht                           | CI/Verifikation fehlschlagen lassen                      | Drift früh erkennen                                  |
| Tabelle ist ausdrücklich global und begründet ausgenommen | RLS-Gate darf sie überspringen                           | dokumentierte enge Ausnahme                          |
| Owner-Verbindung wird genutzt                             | eigene Autorisierung und Tenantbegrenzung verlangen      | Owner kann RLS umgehen                               |

## Ausnahmen und Grenzfälle

Die Allowlist enthält Prisma-Migrationen, den globalen Steuernachrichten-Cache
und den globalen owner-only Monotonie- und Policy-Anker des FIDO-MDS-BLOBs.
Letzterer enthält keine Mandanten- oder Personendaten und entzieht der
App-Rolle alle Tabellenrechte. Die App-Rolle erhält nur EXECUTE auf einen
parametrisierten SECURITY-DEFINER-Guard, der BLOB-Serie, Policy-Revision und
Policy-Hash exakt vergleicht und den Anker bis Transaktionsende share-lockt.
Die Serie `0` ist ausschließlich der fail-closed Initialzustand ohne bereits
verifizierten MDS-BLOB und kann keinen WebAuthn-Commit freigeben. Eine später
deaktivierte Policy darf die historische positive Serie behalten; ihr
abweichender deaktivierter Policy-Hash sperrt die Hardware-Pfade. RLS
verhindert keine unzulässige
Einsicht eines berechtigten
Mitarbeiters innerhalb desselben Tenants. SECURITY-DEFINER-Funktionen und
Owner-Clients benötigen eine eigene, enge Prüfung. Restore, Replikation und
direkter Datenbankbetrieb liegen außerhalb des Anwendungstests.

## Beispiele

### Normalfall

Session A setzt Tenant A und fragt alle Mandanten ab. Zeilen von Tenant B sind
für die App-Rolle unsichtbar, auch wenn ein App-Filter versehentlich fehlt.

### Grenzfall

Eine neue tenantbezogene Tabelle wird migriert, aber nicht mit FORCE RLS und
Policy versehen. `verify:rls` muss den Build stoppen; bis zur Ergänzung besteht
keine behauptete Abdeckung für diese Tabelle.

## Umsetzung in TaxTronik

Unabhängige Kalender-Abos werden bei Änderung der Login-E-Mail,
Deaktivierung sowie Wiederaktivierung eines zuvor inaktiven Kontakts durch
eine atomar erhöhte Tokenversion dauerhaft entwertet. Das gilt auch für die
Reaktivierung über Einladung oder Onboarding. Neue Berechtigung oder Rückkehr
zur früheren E-Mail macht alte Feed-URLs nicht wieder gültig. Rein kosmetische
Kontaktänderungen lassen bestehende Kalender-Abos nutzbar. Die Regression
führt die echten Kontakt-Actions, HMAC-Tokenprüfung und Feed-Route aus und
vergleicht entzogene, neu ausgestellte und fremde Kontakt-URLs.

Die aktuelle Sitzung wird vor jeder Auth.js-Cookie-Erneuerung gegen den
Redis-Widerruf und den aktuellen Konto-/Tenant-/Mandatszustand geprüft.
Unzulässige oder nicht prüfbare Tokens werden bereits im JWT-Callback verworfen;
der HTTP-Endpunkt entfernt dann das Sitzungscookie. Ein signierter
`sessionIssuedAt`-Wert bewahrt den ursprünglichen Anmeldezeitpunkt über
Erneuerungen hinweg. Tokens ohne diesen Wert werden gesperrt, weil ihr `iat`
durch die frühere Cookie-Erneuerung bereits verschoben sein kann. Nach dem
Deployment benötigen bestehende Staff- und Portal-Sitzungen einmalig eine
neue Anmeldung. Fehlende oder ungültige Zeitwerte bleiben gesperrt. Damit
öffnet auch eine mit dem Widerruf überlappende Erneuerung die Sitzung nicht
erneut. Direkte Serverzugriffe und Session-Callbacks verwenden dieselbe
aktuelle Validierung; zusätzliche Staff-Auth-Revisionen werden nicht adoptiert.

Auch direkt ausgestellte Sitzungen enthalten `sessionIssuedAt`: der lokale
Staff-Passwort-Formularpfad ohne TOTP und neue Portal-Magic-Link-Anmeldungen
setzen ihn beim Ausstellen des JWT. Ein erfolgreiches
Login darf kein Cookie erzeugen, das die unmittelbar folgende Server-Auth
wegen eines fehlenden ursprünglichen Anmeldezeitpunkts wieder verwirft.
Die strikte Ablehnung bestehender Tokens ohne diesen Claim bleibt erhalten.

Neue Magic-Link-Anmeldungen setzen zusätzlich `sessionOriginContactId`.
Profilwechsel übernehmen beide signierten Werte unverändert. Aktuelles Profil
und ursprünglicher Login-Kontakt müssen weiterhin im selben Tenant aktiv sein,
ihre normalisierte E-Mail muss der verifizierten Sitzung entsprechen und ihre
Mandate müssen aktiv sein. Die Profilauswahl gleicht die aktuelle DB-E-Mail mit
der verifizierten Session-E-Mail ab. Ein überlappender E-Mail-Wechsel darf keine
fremde Mailbox-Identität übernehmen. Widerrufe beider Kontakte werden gegen den
ursprünglichen Anmeldezeitpunkt geprüft; Logout aus einem abgeleiteten Profil
widerruft den Login-Anker. Portal-Cookies ohne gültigen Ursprungsanker werden
abgewiesen. Beim Deployment ist eine einmalige Portal-Neuanmeldung nötig,
weil historische Profilwechsel nicht zuverlässig rekonstruierbar sind.

Redis-Widerrufszeitpunkte steigen durch einen atomaren Lua-Vergleich monoton.
Verspätete ältere Schreibvorgänge dürfen bereits widerrufene Tokens nicht
reaktivieren. Nur ein bestätigter Redis-null-Wert bedeutet fehlenden Cutoff;
leere, beschädigte oder nicht sicher ganzzahlige Werte sperren Sitzungen und
werden beim Widerruf nicht als gültiger Zustand überschrieben.

Die Regression belegt einen absichtlich verzögerten alten Schreibvorgang
gegen eine isolierte echte Redis-Instanz. Portaltests führen echte Action,
Profilresolver, JWT-Codec und Server-Hydration gegen simulierte DB-/Redis-
Grenzen aus; sie prüfen Ziel-/Quellwiderruf, E-Mail-Wechsel, mehrfachen
Profilwechsel, Logout-Anker und die Ablehnung historischer Cookies.

Die Regression nutzt die installierte Auth.js-HTTP-Sessionverarbeitung und
JWT-Verschlüsselung mit simulierten DB-/Redis-Grenzen. Sie prüft Widerruf,
mehrfache Erneuerung, bestehende Tokens, Konto-/Mandatssperren, Auth-Revision,
ungültige Claims und Ausfälle. Dies ist kein externer Penetrationstest.
Zusätzlich werden die tatsächlich vom Staff-Formularhandler und Portal-
Session-Schreiber ausgestellten Cookies mit der echten JWT-Verschlüsselung
eingelesen, über den Auth.js-HTTP-Pfad erneuert und anschließend anhand eines
zwischen Anmeldung und Erneuerung liegenden Widerrufs gesperrt.

Im regulären Passwort-/TOTP-Modus nimmt dasselbe beschriftete Loginfeld
entweder einen sechsstelligen TOTP oder einen vollständigen zehnstelligen
Recovery-Code aus dem beim Enrollment ausgegebenen Alphabet entgegen. Das
Längenlimit und die Browser-Formatprüfung dürfen den bereits unterstützten
Recovery-Pfad nicht abschneiden. Die mobile Tastatur erlaubt dafür auch
Buchstaben. Die serverseitige Passwortprüfung, die zeitliche TOTP-Prüfung,
der Redis-Replay-Schutz und der atomare Verbrauch des gehashten Backup-Codes
bleiben maßgeblich. Ein Backup-Code ist weiterhin weder Hardware-only-
Fallback noch Ersatz für den frischen TOTP eines administrativen Step-up.
Der Render-Regressionsnachweis prüft die tatsächliche zweite Loginansicht mit
vollständigen TOTP-/Recovery-Eingaben und ungültigen Formaten; er ersetzt
keinen Browser- oder Datenbanknachweis des einmaligen Verbrauchs.

`withTenantContext` setzt die drei `app.current_*`-Werte transaktionslokal und
serialisiert Queries auf der Verbindung. Die Migration aktiviert und erzwingt
RLS. `verify-rls.ts` inventarisiert Tabellen, RLS-Flags und Policies; der
Cross-Tenant-Test verwendet getrennte App-Sessions für Lesen und Mutieren.

Steuerverbindungen und lokale GwG-Personenanker sind Teil derselben
Tabelleninventur. Beide führen den zentralen Tenant-/Client-Paartrigger
zusätzlich zu ihren Fremdschlüsseln. Steuerverbindungs-Policies prüfen außerdem
aktive Portalzugehörigkeit beziehungsweise den aktuellen Mitarbeiterzugriff
einschließlich eingeschränkter und vertraulicher Mandate; Portalakteure dürfen
keine kanonischen Steuerdaten ändern.

Die Ausbauaggregate nutzen ebenfalls erzwungene RLS einschließlich Eltern-,
Mandanten- und Fachrechteprüfung. Arbeitnehmerlinks erhalten nur eng begrenzte
Capability-Funktionen; sie etablieren weder einen Portal- noch einen
Systemakteur für die Kanzlei. Lohnarchive sind zusätzlich auf Dokument- und
Benachrichtigungsebene eingeschränkt. Berechtigungshilfen sind an den aktuellen
Tenant und Akteur gebunden.

Die fünf Tabellen des sicheren Mandantenposteingangs verwenden ebenfalls
ENABLE/FORCE RLS und den zentralen Tenant-/Client-Paartrigger. Kontaktprivate
OPEN-Batches, mandantenweite abgesendete Threads sowie Staff-Zugriff mit
`PORTAL_INBOX_MANAGE` und aktuellem Mandantenzugriff sind getrennte Policies.
Eine Safe-Projection für abgelehnte Anlagen bindet Tenant, Thread und aktiven
Kontakt erneut; sie erweitert keinen Byte- oder Storagezugriff.

Staff-WebAuthn-Credentials sind ebenfalls tenantgebunden und durch
ENABLE/FORCE RLS geschützt. INSERT und generisches UPDATE bleiben auf das
eigene aktive Staff-Konto beziehungsweise SYSTEM begrenzt. Fremde Credentials
können nur über eine schmale SECURITY-DEFINER-Recovery-Prozedur widerrufen
werden; sie prüft nach deterministisch geordneten Actor-/Target-Advisory-Locks
den aktuellen Active-, Rollen-, Ziel- und Hardwaremodus-Stand neu und bildet
die Hierarchie ADMIN → PARTNER/EMPLOYEE sowie PARTNER → EMPLOYEE ab.
Rollenwechsel sowie StaffUser-Änderungen an `active`, `authRevision` und
Hardwaremodus teilen dieselben Kontolocks. Die Web-Oberfläche und der
Datenbank-Backstop verhindern, dass ein Staff-Akteur seine eigene ADMIN-Rolle
entfernt; PARTNER dürfen PARTNER-Rollen nicht entfernen. Reguläre Passwort-
und TOTP-Resets prüfen die aktuelle Actor-Auth-Revision unter denselben
Kontolocks neu und widerrufen auch Credentials eines derzeit nicht im
Hardwaremodus befindlichen Zielkontos. Selbständige Passwortänderungen
widerrufen ebenfalls alle eigenen aktiven Hardware-Credentials. Sämtliche
Registrierungs-, Modus-, Widerrufs- und Recovery-Ceremonies werden an die
Auth-Revision der signierten Staff-Sitzung gebunden. Attestation-Provenienz und
sicherheitsentscheidende Credential-Metadaten sind nach der Registrierung
unveränderlich. Dazu gehört die serverseitig attestierte Authenticator-/
Firmware-Version: Für Bestands-Credentials ohne verifizierte Provenienz bleibt
sie nullable, gesetzte Werte sind auf den uint32-Bereich von 0 bis 4294967295
begrenzt und nach dem Registration-Write nicht mehr änderbar.

Der vorgelagerte MDS-Vertrauenspfad bindet den signierten Gesamt-BLOB an eine
eng freigegebene Signer-/Intermediate-Identität, prüft Status und
Firmware-Mindeststände und behandelt Zertifikatsketten-/CRL-Fehler
fail-closed. Zertifikatsketten werden vor jedem CRL-Netzzugriff an eine exakte
Trust Anchor sowie kritische CA-BasicConstraints, KeyUsage und Pfadlänge
gebunden; Sperrlisten müssen frisch und vom tatsächlichen Issuer signiert sein.
Mehrere oder partitionierte Distribution Points, Reason-/Issuer-Scope,
Zertifikat-seitige Freshest-CRL-Verweise, Delta-/IDP-/Freshest-CRLs und
unbekannte kritische CRL-Extensions werden fail-closed abgewiesen, damit keine
partielle Sperrliste als vollständige Negativauskunft gilt.
Die Zertifikat-AAGUID muss verpflichtend zur signierten Authenticator-AAGUID
passen. Größen- und 30-Sekunden-Grenzen begrenzen Registrierung und externe
Prüfung. Nach kryptografischer Prüfung von Signatur, fortlaufender Serie und
`nextUpdate` wird die BLOB-Serie clusterweit monoton in der Tabelle
`fido_mds_trust_state` verankert, bevor die lokale Modell-Allowlist gefiltert
wird. Ein valider neuer BLOB ohne lokal nutzbares Modell verdrängt damit
trotzdem ältere Prozess-Caches; der konkrete Hardware-Vorgang schlägt danach
fail-closed fehl. Prozesslokale MDS-Snapshots werden spätestens stündlich
aktualisiert.

Die sortierte AAGUID-Allowlist und der Aktivierungszustand werden zusätzlich
als SHA-256-Policy-Hash mit einer operativ erhöhten Policy-Revision gebunden.
Der Produktionsstart beansprucht diese Bindung nur in der Datenbank und ruft
das externe MDS nicht auf. Eine leere oder den Null-AAGUID enthaltende
Allowlist beansprucht den global deaktivierten Zustand. Dieselbe Revision mit
abweichendem Hash wird abgewiesen; eine höhere Revision verdrängt ältere
Replikas. Jede sicherheitsrelevante WebAuthn-Mutation übernimmt Serie,
Policy-Revision und Policy-Hash aus der Trust-Prüfung und hält dieses exakte
Tripel über den schmalen Definer-Guard bis zum Commit. MDS-/Policy-Anker werden
dabei vor Staff-Kontolocks beansprucht; parallel überholte Snapshots oder
Policies können nicht committen. Die versionsgebundene Dependency-Härtung ist
über Patch- und Lockfile-Hash im Supply-Chain-Gate abgesichert.

Der privilegierte ADMIN-Owner-CLI-Pfad verlangt exakte E-Mail- und Tenant-Slug-
Angaben, prüft die ADMIN-Zuordnung nach dem gemeinsamen Kontolock erneut und
mutiert nur genau diesen Treffer. Seine Credential-Datei wird exklusiv,
symlinksicher und vor dem Datenbank-Commit geschrieben. Das Klartextpasswort
erscheint nur in dieser Datei, nie in Terminalausgabe oder Anwendungslog. Bei
Fehlern wird ausschließlich eine in diesem Lauf teilweise erzeugte Datei
entfernt; Datei und auf POSIX-Systemen das Elternverzeichnis werden vor Commit
per `fsync` persistiert. Ein Datei-/`fsync`-Fehler rollt Reset und Audit
gemeinsam zurück. Scheitert erst der Datenbank-Commit, kann eine bereits
dauerhaft geschriebene, aber nicht wirksame Datei als betrieblich zu
bereinigendes Artefakt verbleiben. Der lokale Dev-Seed setzt bestehende
Admin-Konten konsistent in den normalen Passwort-/TOTP-Onboarding-Modus zurück,
widerruft aktive Hardware-Credentials und erhöht die Auth-Revision in derselben
Transaktion.

## Bekannte Abweichungen und Grenzen

Für die registrierten Tabellen ist der beschriebene Backstop implementiert.
Der Status ist an das laufende Drift-Gate gebunden: neue Tabellen,
SECURITY-DEFINER-Funktionen oder Owner-Pfade können neue Risiken schaffen. Der
Nachweis ist weder Penetrationstest noch Aussage über Netzwerk-, Backup- oder
Host-Isolation.

## Fachliche Prüffragen

- Sind alle tatsächlich tenantbezogenen Tabellen und Funktionen inventarisiert?
- Welche Owner- und SECURITY-DEFINER-Pfade sind betrieblich zulässig?
- Reichen die dokumentierten globalen Ausnahmen weiterhin aus?
- Wie wird die RLS-Prüfung in jeder Zielumgebung nachgewiesen?

## Technische Nachweise

Der Datenbanktest belegt Cross-Tenant-Sperren für Lesen, Einfügen, Aktualisieren
und Löschen sowie Paar-Guards ausgewählter Tabellen. Das Skript belegt den
Schema-Inventurmechanismus. Beides beweist nicht die Sicherheit privilegierter
Zugänge oder eine vollständige Angriffssimulation.

Der Inbox-RLS-Test ergänzt Cross-Client-, Kontakt-, Rechteentzugs-, Draft-,
Attachment- und SECURITY-DEFINER-Fälle. Er belegt nicht die Autorisierung jeder
HTTP- oder Owner-Call-Site.

Die Staff-WebAuthn-Tests belegen Cross-Tenant-Sperren, die hierarchische
Credential-RLS, Self-only-INSERT/-UPDATE, den ausschließlich prozeduralen
Fremdwiderruf, den Rollenboden, die Auth-Revision-Prüfung regulärer
Security-Resets, deren Widerruf ruhender Credentials und unveränderliche
Attestation-/Gerätemetadaten. Die Race-Tests
in `staff-webauthn-rls.test.ts` belegen, dass parallele Widerrufe die
Zwei-Schlüssel-Mindestzahl wahren, Recovery auf einen laufenden Rollenwechsel
wartet, einen danach zum PARTNER erhöhten Zielnutzer mit frischem Snapshot
abweist und nach parallel committeter Actor-Deaktivierung nicht mehr
widerruft. Die WebAuthn- und Admin-Action-Tests belegen den Step-up per
aktuellem Passwort und frischem TOTP ohne Backup-Code-Fallback beziehungsweise
per eigenem Hardware-Schlüssel sowie die Challenge-Bindung an Actor, Zielkonto
und Auth-Revision. Vorab- und Step-up-Reads liegen vor der Definer-Prozedur;
diese ist der erste Datenbank-Lock-/Mutationsschritt. Frische Actor-, Ziel- und
Hierarchieprüfungen erfolgen unter den gehaltenen Locks vor den entscheidenden
Zielmutationen und dem Audit. Bei Hardware-Recovery bilden Moduswechsel und
`authRevision`-Erhöhung den transaktionalen Session-Cutoff; die Action-Tests
belegen, dass vor einer möglicherweise abgewiesenen DB-Transaktion kein
irreversibler Redis-Widerruf des Zielkontos ausgeführt wird. Derselbe Nachweis
gilt für den regulären Hardware-Moduswechsel im Profil.

Der Owner-CLI-Test belegt die erneute Tenant-/ADMIN-Prüfung nach dem Lock, die
atomare Kopplung von Recovery und Audit sowie die exklusive, symlinksichere
Credential-Ausgabe ohne Klartextausgabe im Terminal vor Commit einschließlich
gezielter Teil-Datei-Bereinigung, Datei-/Elternverzeichnis-Synchronisierung
und Rollback bei Ausgabefehlern. Der Dev-Seed-Test belegt
Modusrückkehr, Credential-Widerruf und Auth-Revision in einer Transaktion.

Migration- und RLS-Test belegen für die attestierte Authenticator-Version den
nullable Bestandswert, die inklusive uint32-Grenze `0..4294967295` und die
Unveränderlichkeit nach Registrierung. Der Profil-Action-Test belegt, dass der
neue Registration-Write den serverseitig attestierten Wert persistiert und
gespeicherte Werte bei Modusprüfungen in das Trust-Mapping übernimmt. Der
Admin-Action-Test weist dieselbe Weitergabe für den eigenen Hardware-Schlüssel
des Recovery-Akteurs nach.

Der WebAuthn-Test belegt zusätzlich Signer-/Intermediate-Bindung, Status- und
Firmware-Mindeststände, fehlende Bestandsprovenienz, Modellisolation,
Zertifikat-AAGUID, Eingabegrenzen, den persistenten Serienanker und das
Gesamtzeitlimit. Der direkte CRL-Härtungstest belegt Fail-close bei Netzwerk-,
HTTP-, Parse-, Signatur-, Issuer- und Freshness-Fehlern, Chain-before-fetch,
strikte CA-Constraints, gemischte RSA-Signaturhashes, die Ablehnung
partitionierter/gescopter/Delta-CRLs, die Abbruchweitergabe sowie das
Größenlimit. Migration und Laufzeittest belegen Singleton-/
Initialzustandsconstraints, den Tabellenrechteentzug der App-Rolle, die
transaktionale Installation des Policy-Guards, den eng gewährten Guard für das
exakte Tripel aus Serie, Policy-Revision und Policy-Hash sowie dessen
transaktionslangen Share-Lock. WebAuthn-Tests belegen außerdem
Serienübernahme vor dem lokalen Modellfilter, globale Deaktivierung,
Same-Revision-Drift, Übernahme einer höheren Revision und Abweisung älterer
Replikas. Das Supply-Chain-Gate belegt die exakte Paket-/Patch-/Lockfile-Bindung. Browser-
Fehlertest und Ops-Test belegen die umschlossene Abbrucherkennung sowie die
Weitergabe der Deployment-Allowlist an den App-Container.
