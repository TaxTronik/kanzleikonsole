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
    Backstop. Mandantenbezogene Worker-Jobs, n8n-Callbacks und der iCal-Feed
    nutzen die App-Rolle im SYSTEM-Kontext; die verbleibenden, im Code
    begründeten Owner-Pfade bleiben gesondert zu kontrollieren.
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
  - apps/web/src/server/backup/restore.ts
  - packages/db/src/restore-security.ts
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
  - apps/web/src/server/rate-limit/index.ts
  - apps/web/src/app/staff/(protected)/dashboard/rss-feed-actions.ts
  - apps/web/src/server/auth/portal.ts
  - apps/web/src/server/auth/magic-link.ts
  - apps/web/src/server/auth/magic-link-entry.ts
  - apps/web/src/app/portal/(auth)/login/actions.ts
  - apps/web/src/app/portal/(auth)/login/verify/page.tsx
  - apps/web/src/server/auth/portal-session.ts
  - apps/web/src/app/staff/(auth)/login/page.tsx
  - apps/web/src/app/staff/(auth)/login/actions.ts
  - apps/web/src/app/staff/(auth)/login/password/route.ts
  - apps/web/src/server/auth/session-issued-at.ts
  - apps/web/src/server/auth/revocation.ts
  - packages/db/src/tenant-context.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260907013230_reminder_tickets/migration.sql
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
  - packages/db/prisma/migrations/20261004140000_audit_verify_checkpoint/migration.sql
  - packages/db/prisma/migrations/20261004140100_audit_anchor_lease/migration.sql
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
  - packages/db/prisma/migrations/20261006160000_owner_role_least_privilege/migration.sql
  - packages/crypto/src/certificate-path.ts
  - apps/web/src/server/auth/webauthn-attestation.ts
  - apps/worker/src/jobs/fido-mds-verify.ts
  - apps/worker/src/jobs/fido-mds-trust-anchors.ts
  - apps/web/src/server/auth/session-factory.ts
  - apps/web/src/server/auth/staff-session.ts
  - apps/web/src/server/auth/staff-login.ts
  - apps/web/src/server/auth/staff-login-ticket.ts
  - apps/web/src/server/auth/staff-password.ts
  - apps/web/src/server/auth/password-hash-pool.ts
  - apps/worker/src/jobs/fido-mds-refresh.ts
  - packages/db/prisma/migrations/20261007100400_document_mandate_artifact_flag/migration.sql
  - apps/web/src/server/auth/authjs-route.ts
  - apps/web/src/app/api/auth/staff/[...nextauth]/route.ts
  - apps/web/src/app/api/auth/portal/[...nextauth]/route.ts
  - packages/crypto/src/crl-fetch.ts
  - apps/worker/src/tenant-context.ts
test_refs:
  - apps/web/src/server/backup/__tests__/restore-security.test.ts
  - apps/web/src/server/backup/__tests__/restore.test.ts
  - packages/db/src/__tests__/restore-security.test.ts
  - apps/web/src/server/auth/__tests__/revocation.test.ts
  - apps/web/src/server/auth/__tests__/revocation.redis.test.ts
  - apps/web/src/server/auth/__tests__/portal-profile-session.test.ts
  - apps/web/src/server/auth/__tests__/portal-profiles.test.ts
  - apps/web/src/app/portal/(protected)/profile-actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/contacts/__tests__/ical-identity-revocation.test.ts
  - apps/web/src/app/staff/(auth)/login/__tests__/code-input.test.tsx
  - apps/web/src/app/staff/(auth)/login/__tests__/totp-enrollment.test.ts
  - apps/web/src/app/staff/(auth)/login/__tests__/totp-setup-race.test.ts
  - apps/web/src/server/auth/__tests__/session-renewal.test.ts
  - apps/web/src/server/auth/__tests__/session-factory.test.ts
  - apps/web/src/server/auth/__tests__/staff-login-ticket.test.ts
  - apps/web/src/server/auth/__tests__/staff-login-without-client-ip.test.ts
  - apps/web/src/server/auth/__tests__/magic-link-request-limit.test.ts
  - apps/web/src/server/rate-limit/__tests__/ip-or-global-limit.test.ts
  - packages/db/src/__tests__/rls-cross-tenant.test.ts
  - packages/db/src/__tests__/reminder-tickets.test.ts
  - packages/db/src/__tests__/tax-master-data.test.ts
  - packages/db/src/__tests__/gwg-person-links.test.ts
  - packages/db/src/__tests__/mailbox-rls.test.ts
  - packages/db/src/__tests__/payroll-intake.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
  - packages/db/src/__tests__/mandate-assistance-expansion.test.ts
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - packages/db/src/__tests__/staff-webauthn-migration.test.ts
  - packages/db/src/__tests__/staff-webauthn-rls.test.ts
  - packages/db/src/__tests__/audit-verify-checkpoint.test.ts
  - packages/db/src/__tests__/audit-anchor-lease.test.ts
  - apps/web/src/server/auth/__tests__/webauthn.test.ts
  - apps/web/src/server/auth/__tests__/admin-break-glass.test.ts
  - apps/web/src/server/auth/__tests__/staff-auth-state.test.ts
  - apps/web/src/server/auth/__tests__/staff-session-auth-binding.test.ts
  - apps/web/src/server/auth/__tests__/staff-second-factor-rate-limit.test.ts
  - apps/web/src/server/auth/__tests__/magic-link-entry.test.tsx
  - apps/web/src/app/staff/(protected)/dashboard/__tests__/rss-feed-actions.test.ts
  - packages/config/src/__tests__/env-webauthn.test.ts
  - packages/db/src/__tests__/dev-seed-auth-reset.test.ts
  - apps/web/src/server/auth/__tests__/simplewebauthn-crl-hardening.test.ts
  - apps/web/src/lib/__tests__/webauthn-browser-error.test.ts
  - apps/web/src/app/staff/(protected)/profile/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/admin/users/__tests__/account-actions.test.ts
  - packages/db/src/__tests__/owner-role-privileges.test.ts
  - packages/crypto/src/__tests__/certificate-path.test.ts
  - apps/web/src/server/auth/__tests__/webauthn-attestation.test.ts
  - apps/web/src/server/auth/__tests__/webauthn-library-contract.test.ts
  - apps/worker/src/jobs/__tests__/fido-mds-library-contract.test.ts
  - packages/db/src/__tests__/document-mandate-artifact-flag.test.ts
  - apps/web/src/server/auth/__tests__/authjs-route.test.ts
  - apps/web/src/server/auth/__tests__/password-hash-pool.test.ts
  - packages/crypto/src/__tests__/crl-fetch.test.ts
  - packages/crypto/src/__tests__/crl-fetch-pinning.test.ts
  - apps/web/src/app/api/portal/ical/[token]/__tests__/route-db.test.ts
  - apps/web/src/server/n8n/__tests__/operations-db.test.ts
  - apps/web/src/server/n8n/__tests__/research-result-db.test.ts
  - apps/worker/src/__tests__/module-gate-db.test.ts
  - apps/worker/src/__tests__/tsa-port-db.test.ts
  - apps/worker/src/jobs/__tests__/audit-anchor-db.test.ts
  - apps/worker/src/jobs/__tests__/audit-verify-check-db.test.ts
  - apps/worker/src/jobs/__tests__/backup-drill-app-role-db.test.ts
  - apps/worker/src/jobs/__tests__/evidence-seal-db.test.ts
  - apps/worker/src/jobs/__tests__/gwg-expiry-check-db.test.ts
  - apps/worker/src/jobs/__tests__/invoice-overdue-check-db.test.ts
  - apps/worker/src/jobs/__tests__/poa-expiry-check-db.test.ts
  - apps/worker/src/jobs/__tests__/portal-inbox-cleanup-db.test.ts
  - apps/worker/src/jobs/__tests__/reminder-done-notify-db.test.ts
  - apps/worker/src/jobs/__tests__/reminders-daily-app-role-db.test.ts
  - apps/worker/src/jobs/__tests__/risk-analyse-llm-db.test.ts
  - apps/worker/src/jobs/__tests__/sanctions-refresh-db.test.ts
  - apps/worker/src/jobs/__tests__/tax-deadline-materialize-db.test.ts
  - apps/worker/src/jobs/__tests__/tax-news-fetch-db.test.ts
  - apps/worker/src/jobs/__tests__/update-check-db.test.ts
  - apps/worker/src/jobs/__tests__/workflow-auto-resume-db.test.ts
  - apps/worker/src/jobs/__tests__/workflow-n8n-dispatch-app-role-db.test.ts
  - apps/worker/src/__tests__/tenant-context.test.ts
  - packages/mail/src/__tests__/dispatch-db.test.ts
  - apps/web/src/server/tax-news/__tests__/fetcher-db.test.ts
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
Owner-Clients benötigen eine eigene, enge Prüfung. Die Restore-CLI prüft
ausdrücklich die unten beschriebenen Rollen-, Rechte- und RLS-Invarianten.
Replikation und direkter Datenbankbetrieb sowie die vollständige Sicherheit
einer Restore-Zielumgebung liegen außerhalb dieser begrenzten Prüfung.

## Beispiele

### Normalfall

Session A setzt Tenant A und fragt alle Mandanten ab. Zeilen von Tenant B sind
für die App-Rolle unsichtbar, auch wenn ein App-Filter versehentlich fehlt.

### Grenzfall

Eine neue tenantbezogene Tabelle wird migriert, aber nicht mit FORCE RLS und
Policy versehen. `verify:rls` muss den Build stoppen; bis zur Ergänzung besteht
keine behauptete Abdeckung für diese Tabelle.

## Umsetzung in TaxTronik

Die RESTRICTIVE-Policy `document_mandate_artifact_scope` prüft
Mandatsartefakte nur für Dokumente mit `document.has_mandate_artifact`. Das
Flag setzt ein Trigger beim Verknüpfen eines Artefakts in derselben Anweisung;
es ist monoton (kein Rücksetzen) und wurde für bestehende Verknüpfungen mit
abschließender Kontrolle nachgetragen. Sichtbarkeit und Schreibprüfung
entsprechen der vorherigen Policy; ein Vergleichstest prüft beide Policies je
Dokumentart und Rolle.

Nach `pg_restore` prüft die Restore-CLI vor jeder Erfolgsmeldung die 17 bisherigen
effektiven Rollen-/Grant-/REVOKE-Invarianten und fünf zusätzliche Invarianten
für dauerhafte Wiedervorlagen-Tickets (`REMINDER-TICKET-001`). Der
tenantgebundene Nummernzähler bleibt vollständig ohne App-Tabellenrechte;
Referenzkanten erlauben nur SELECT und INSERT. Die beiden Ticket-Triggerfunktionen
sind weder für PUBLIC noch die App-Rolle direkt ausführbar. Sieben weitere
Invarianten sichern die Schreibsperren der Audit-Nachweise: Rolling Anchors
(`audit_anchor`) darf die App-Rolle weder ändern, löschen noch leeren, die
Prüf-Checkpoints (`audit_verify_checkpoint`) zusätzlich nicht anlegen; dort
schreibt nur der Owner. Eine weitere Invariante belegt, dass die App-Rolle am
Anchor-Lease (`audit_anchor_lease`) keinerlei Tabellenrechte hat. Die
Restore-Selbsttest-Assertion prüft denselben Satz von insgesamt 30
Invarianten.
Die Rollenprüfung umfasst zusätzlich per `SET ROLE` erreichbare privilegierte
Rollen und Tabellenowner. Audit-Tabellen werden ausdrücklich im Schema
`public` geprüft, unabhängig vom `search_path` der Verbindung.
Zusätzlich inventarisiert sie normale und partitionierte öffentliche Tabellen:
ENABLE/FORCE RLS und mindestens eine Policy sind Pflicht, abgesehen von den
drei dokumentierten globalen Ausnahmen. Ein leeres Inventar ist kein Erfolg.
Diese Prüfung bleibt auch bei `--no-smoke-test` aktiv. Ziel-Defaultprivilegien
können beim Neuanlegen von Tabellen zuvor entzogene Rechte erneut vergeben;
ein erfolgreicher `pg_restore`-Exit allein genügt deshalb nicht.
Vor `pg_restore` verlangt die Restore-CLI zusätzlich die S-01-Owner-Rolle
`taxtronik_owner` mit NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
BYPASSRLS und ohne Rollenmitgliedschaften. Nach `pg_restore` prüft sie vor den
30 Invarianten deren Attribute, fehlenden Objektbesitz und fehlendes CREATE,
die Grants der Migration `20261006160000` sowie die Schreibsperren auf
`audit_log`, `audit_seal`, `audit_anchor`, `audit_archive` und
`_prisma_migrations`; TRUNCATE, REFERENCES, TRIGGER sowie ab PostgreSQL 17
MAINTAIN sind nirgends erlaubt. Fehlende S-01-Grants meldet sie als Dump von
vor S-01 mit dem Verfahrenshinweis (passendes altes Release wiederherstellen,
dann `./taxtronik update`).

Eine nicht erfüllte oder nicht ausführbare Sicherheitsprüfung beendet die CLI
mit Fehler und untersagt im Ergebnistext den Dienststart. Der eigentliche
Restore ist zu diesem Zeitpunkt bereits angewendet; die nachgelagerte Prüfung
behauptet keinen Rollback und ändert keine Zielrechte automatisch. Zielrechte
und RLS müssen geprüft und eine sichere Wiederherstellung erneut nachgewiesen
werden. Die Prüfung ersetzt weder Auditketten-/Migrationsprüfung noch die
betriebliche Freigabe der Zielumgebung.

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
Unzulässige oder nicht prüfbare Tokens werden bereits im JWT-Callback verworfen.
Über HTTP erreichen nur noch `GET csrf` und `POST signout` beider Oberflächen
sowie die Callbacks der beiden Staff-Credentials-Provider Auth.js; der
Sessionendpunkt, `signin`, `providers`, `error`, alle übrigen Aktionen und der
Portal-Callback antworten 404, eine erlaubte Aktion mit anderer Methode 405,
jeweils ohne Auth.js aufzurufen. Damit erneuert kein HTTP-Endpunkt mehr ein
Sitzungscookie; die Prüfung im JWT-Callback bleibt als Absicherung. Ein signierter
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

Sitzungen beider Oberflächen enden absolut 24 Stunden nach dem signierten
ursprünglichen Anmeldezeitpunkt. Seitenaufrufe erneuern das Cookie nicht;
Anmeldung und Portal-Profilwechsel stellen JWTs aus, deren Ablauf höchstens
auf Anmeldung plus 24 Stunden gesetzt wird. Ein
Cookie jenseits dieser Grenze wird abgewiesen, auch wenn eine frühere
gleitende Erneuerung seinen Ablauf verlängert hatte; Tokens ohne gültigen
Anmeldeanker werden nie verlängert. Session-Fabrik-, Erneuerungs- und
Profilwechseltests belegen die Obergrenze für beide Oberflächen.

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

Alle öffentlichen Magic-Link-Einstiege begrenzen Datenbankabfragen vor dem
Tokenlookup. Die Portal-Auth.js-Instanz besitzt keinen Provider; ein
Einmal-Link wird ausschließlich über die Bestätigungs-Server-Action eingelöst.
Sie hat ein eigenes Kontingent von zehn Versuchen je zehn Minuten und
Client-IP; die GET-Profilauswahl besitzt ein eigenes Lesekontingent von 30
Aufrufen je zehn Minuten und verbraucht weiterhin keinen Einmal-Link. Ohne
vertrauenswürdige Client-IP gilt für beide je Endpunkt nur eine
Sturm-Obergrenze von durchschnittlich zehn Anfragen je Sekunde. Bei
erschöpftem Kontingent erfolgen weder Tokenverbrauch noch Sessionausstellung.
Die Anzeige unterscheidet vorübergehende Drosselung von einem ungültigen oder
verbrauchten Link. Magic-Link-Anforderungen sind je Client-IP und zusätzlich
je HMAC der normalisierten E-Mail-Adresse auf fünf je 15 Minuten begrenzt;
der Schlüssel entsteht vor jedem Lookup und behandelt bekannte und unbekannte
Adressen gleich. Ohne Client-IP deckelt zusätzlich eine Versandobergrenze von
100 tatsächlich versendeten Login-Mails je 15 Minuten. Laufzeitregressionen
führen die Bestätigungs-Action und die gerenderte Profilauswahl mit
simulierten Auth-/Persistenzgrenzen aus und belegen, dass die
Portal-Instanz keinen Provider hat.

Staff-Anmeldungen prüfen das Passwort genau einmal: Der Passwortschritt
(`staff-login.ts`) bündelt Kontolookup, Sperr- und Modusprüfung, das
kontogebundene Limit von 20 Versuchen je zehn Minuten vor bcrypt, genau einen
bcrypt-Vergleich und das Fehlversuchs-Audit. Danach stellt der Server ein fünf
Minuten gültiges Einmal-Ticket aus (`staff-login-ticket.ts`), gebunden an
Zweck, Konto, Tenant, `authRevision` und einen SHA-256 des geprüften
Passwort-Hashes; Redis speichert nur den Hash des Tickets. TOTP/Backup-Code im
Credentials-Provider, das TOTP-Erstsetup und der lokale DEV-Formularpfad lösen
es atomar ein, statt das Passwort erneut zu prüfen. Ein zweiter Einsatz, eine
geänderte Revision oder ein geändertes Passwort, Deaktivierung, Sperre oder
Hardware-only-Wechsel dazwischen, ein falscher Zweck oder ein abgelaufenes
Ticket führen zur Neuanmeldung; ohne Redis wird kein Ticket ausgestellt. Die
IP-Limits der Login-Schritte greifen nur mit vertrauenswürdiger Client-IP;
ohne sie gelten die kontogebundenen Limits und je Endpunkt die
Sturm-Obergrenze.

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
zwischen Anmeldung und Erneuerung liegenden Widerrufs gesperrt. Diese
Erneuerung ist über die Route seit B5 nicht mehr erreichbar; die Regression
belegt die Prüfung im JWT-Callback als Absicherung. Der Routentest belegt je
Oberfläche, dass genau die erlaubten Endpunkte Auth.js erreichen und alle
übrigen mit 404 beziehungsweise 405 ohne Auth.js-Aufruf antworten, gegen
echtes Auth.js auch Credentials-Callback, Fehlerumleitung zur Anmeldung und
Abmelden.

Im regulären Passwort-/TOTP-Modus nimmt dasselbe beschriftete Loginfeld
entweder einen sechsstelligen TOTP oder einen vollständigen zehnstelligen
Recovery-Code aus dem beim Enrollment ausgegebenen Alphabet entgegen. Das
Längenlimit und die Browser-Formatprüfung dürfen den bereits unterstützten
Recovery-Pfad nicht abschneiden. Die mobile Tastatur erlaubt dafür auch
Buchstaben. Die serverseitige Passwortprüfung, die zeitliche TOTP-Prüfung,
der Redis-Replay-Schutz und der atomare Verbrauch des gehashten Backup-Codes
bleiben maßgeblich. Ein Recovery-Code wird im begrenzten Worker-Thread-Pool
der Passwortprüfung stets mit allen gespeicherten Hashes verglichen, ohne
Abbruch beim ersten Treffer; ist der Pool ausgelastet oder gestört, wird der
Versuch ohne Vergleich, ohne gezählten Fehlversuch und ohne Verbrauch mit
derselben Meldung abgewiesen. Pool- und Login-Tests belegen je Versuch einen
Pool-Aufruf mit allen Hashes, jeden Hash genau einmal verglichen,
unveränderte Ergebnisse und Verbrauch sowie diese Abweisung. Ein Backup-Code
ist weiterhin weder Hardware-only-Fallback noch Ersatz für den frischen TOTP
eines administrativen Step-up.
Der Render-Regressionsnachweis prüft die tatsächliche zweite Loginansicht mit
vollständigen TOTP-/Recovery-Eingaben und ungültigen Formaten; er ersetzt
keinen Browser- oder Datenbanknachweis des einmaligen Verbrauchs.

TOTP und Backup-Codes teilen sich nach erfolgreicher Passwortprüfung ein
eigenes kontogebundenes Limit von fünf Prüfversuchen je fünf Minuten. Dieser
Zähler ist von IP-Buckets, Passwortversuchen und dem bisherigen Kontolockout
getrennt. Eine erfolgreiche Passwort-Vorprüfung kann ihn nicht zurücksetzen;
wechselnde Quell-IPs schaffen kein zusätzliches Kontingent. Erst ein
vollständig erfolgreicher Login einschließlich des transaktionalen Audits
setzt das Limit zurück. Fehlende Codes oder falsche Passwörter verbrauchen
dieses Kontingent nicht. Nicht verfügbare Redis-Prüfung sperrt den
Produktionslogin weiterhin. Die Regression führt reale Passwort-Action,
Credentials-Provider, Rate-Limiter und Lockout mit zustandsbehafteten
Persistenz-Doubles aus und prüft verteilte Versuche, Ablauf, Recovery-Verbrauch,
Replay, Auditfehler, Redis-Ausfall und den fortbestehenden Hardware-only-Ausschluss.

Das öffentliche Staff-TOTP-Erstsetup bindet den nach bcrypt erneut gelesenen
Kontostand an genau den geprüften Passwort-Hash und die ursprüngliche
`authRevision`. Neue Secrets werden nur bei weiterhin aktivem, nicht
gesperrtem Passwortkonto und unverändert offenem Setup atomar beansprucht.
Ein verspäteter Passwortvorschritt darf ein inzwischen bestätigtes Enrollment
nicht wieder öffnen oder dessen Secret ersetzen. Vor Ausgabe von Secret und
lokal gerendertem QR werden Konto, Revision, Secret, offenes Enrollment und
das 60-Minuten-Fenster erneut geprüft. Auch der abschließende Enrollment-Claim
nach dem Backup-Code-Hashing verlangt denselben Passwort-/Revisionsstand,
aktiven Passwortmodus und fehlende aktuelle Kontosperre. Verlorene Claims
geben weder neue Secrets noch Backup-Codes aus und schreiben kein
Enrollment-Audit. Erfolgreiche Bestätigung und Audit bleiben transaktional
gekoppelt; ein bereits offenes, unverändertes Setup behält sein Secret.

Die Setup-Regressionsfälle führen die echten öffentlichen Actions mit
zustandsbehafteten Persistenz-Doubles aus. Gezielte Zustandswechsel während
Passwortprüfung, Secret-Erzeugung, QR-Rendering und Backup-Code-Hashing sowie
zwei parallele Setup-Aufrufe belegen die Rückweisung veralteter Claims. Sie
ersetzen keinen Parallelitätstest gegen einen echten PostgreSQL-Server.

`withTenantContext` setzt die drei `app.current_*`-Werte transaktionslokal und
serialisiert Queries auf der Verbindung. Die Migration aktiviert und erzwingt
RLS. `verify-rls.ts` inventarisiert Tabellen, RLS-Flags und Policies; der
Cross-Tenant-Test verwendet getrennte App-Sessions für Lesen und Mutieren.

Der iCal-Feed des Portals (`api/portal/ical/[token]`) kennt vor dem
Tenantkontext nur die Kontakt-ID aus dem signierten Token. Die
Owner-Verbindung löst daraus ausschließlich die Tenant-ID auf; Kontakt,
Token-Version, Mandantenstatus, Modulschalter, Fristen und Termine liest die
App-Rolle im SYSTEM-Kontext dieses Tenants (`withSystemContext`). Der
PostgreSQL-Test der Route belegt denselben Feed, die Tenant-Auflösung als
einzigen Owner-Zugriff und die Unsichtbarkeit fremder Fristen und Termine.

Die n8n-Callbacks (überfällige Anforderungen, Anforderungsdetails, ablaufende
GwG-Prüfungen, Receipt-Recovery, Rechercheergebnisse) lesen und schreiben nach
der Credential-Prüfung über die App-Rolle im SYSTEM-Kontext des
authentifizierten Tenants. Die mandantenbezogenen Worker-Jobs tun dasselbe
(`withSystemContext`; für Kerne mit eigenem DB-Parameter `systemContextClient`,
je Aufruf eine kurze Transaktion im SYSTEM-Kontext), ebenso der gemeinsame
Mail-Versand für Vorlage, Mandant und Empfänger. Der manuelle
Steuernachrichten-Abruf im Dashboard läuft vollständig im Kontext des
angemeldeten Mitarbeiters (`withTenantContext`), einschließlich des globalen
Nachrichten-Caches. Beim Owner-Client bleiben mandantenübergreifende Tenant-
und Kandidatenlisten (nur IDs; beim Steuernachrichten-Job Tenant und
Feed-URL), Auflösungen vor jedem Tenant-Kontext sowie Wartungspfade mit
fehlenden App-Rechten oder tenantlosen Daten (Archivierung, Anker-Lease und
Anker, Prüf-Checkpoints, Backup und Restore-Drill, Aufbewahrung, Mail-Outbox-
und n8n-Zustellung, Nachrichten-Cache des Steuernachrichten-Jobs); jeder
dieser Pfade nennt seinen Grund im Code. Je verschobenem Pfad belegt eine
PostgreSQL-Suite mit Owner- und App-Verbindung wie im CI, dass der Pfad ohne
weiteren Owner-Zugriff dieselben Zeilen liest und schreibt und dass Zeilen
eines fremden Tenants im SYSTEM- beziehungsweise Mitarbeiterkontext unsichtbar
bleiben; gegen die vorherige Implementierung scheitern die Suiten am
Owner-Zugriff.

Die Prüf-Checkpoints der Audit-Kettenprüfung (`audit_verify_checkpoint`,
`AUDIT-VERIFY-ALERT-001`) sind tenantgebunden und durch ENABLE/FORCE RLS sowie
eine Tenant-Policy geschützt. Die App-Rolle erhält nur SELECT; Anlegen,
Fortschreiben und Löschen bleiben der Owner-Verbindung des Prüf-Workers
vorbehalten, deren Abfragen den Tenant ausdrücklich binden. Der Migrationstest
belegt Rechte, erzwungene RLS und das Lesen ausschließlich des eigenen
Checkpoints im Tenantkontext.

Der Tenant-Lease des Rolling-Anchor-Workers (`audit_anchor_lease`,
`AUDIT-RFC3161-ANCHOR-001`) ist ebenfalls tenantgebunden und durch
ENABLE/FORCE RLS sowie eine Tenant-Policy geschützt. Die App-Rolle erhält
keinerlei Tabellenrechte; nur die Owner-Verbindung des Workers beansprucht,
verlängert und löscht Leases mit ausdrücklicher Tenantbindung. Der Test belegt
Rechteentzug, erzwungene RLS und die Policy.

Persönliche RSS-Abonnements verwenden zusätzlich zur tenantweiten RLS bei
Aktivierung und Löschung die aus der Sitzung abgeleitete Mitarbeiter-ID.
Eine bekannte fremde Feed-ID desselben Tenants berechtigt weder zum Lesen
der Löschmetadaten noch zur Änderung oder Löschung des Abonnements. Die
Action-Regression prüft eigene, mitarbeiterfremde und tenantfremde IDs gegen
ein zustandsbehaftetes Persistenz-Double sowie den fehlenden Sessionkontext.

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
partielle Sperrliste als vollständige Negativauskunft gilt. CRL-Abrufe
erreichen nur öffentliche Adressen: Der Host wird einmal aufgelöst;
Loopback-, private, Link-local-, CGNAT-, Multicast- und unspezifizierte
Adressen, auch IPv4-gemappt, werden ohne Verbindungsaufbau abgewiesen. Die
Verbindung ist auf die geprüften Adressen gepinnt, Redirects werden nicht
verfolgt; jede Abweisung sperrt wie eine nicht erreichbare Sperrliste.
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
Policies können nicht committen.

Die Ketten- und Sperrlistenprüfung der Hardware-Anmeldung ist eigener Code
(`@taxtronik/crypto/certificate-path`). Die App prüft die Attestationskette
gegen die Wurzeln des signaturgeprüften MDS-Eintrags
(`webauthn-attestation.ts`), der Worker die MDS-Signaturkette gegen gepinnte
Wurzeln (`fido-mds-verify.ts`, `fido-mds-trust-anchors.ts`); Sperrlisten werden
erst nach erfolgreicher Signaturprüfung geladen. `@simplewebauthn/server`
läuft ungepatcht in der exakt gepinnten Version 13.3.3, erhält keine
Wurzelzertifikate und prüft daher weder Ketten noch Sperrlisten selbst und
greift nicht aufs Netz zu. Das Supply-Chain-Gate prüft den Versionspin und
diesen Aufrufvertrag anhand fester Härtungsmarker im Repository-Code.

Der technische Paketmanager-Pin wird für Repository, CI, Container und
One-Click-Host synchron auf pnpm `12.4.1` geführt und im Supply-Chain-Gate
geprüft. Die Build-Script-Sollliste enthält die versionsgebundene Entscheidung
`tesseract.js@7.0.0: false`: Dessen Postinstall zeigt ausschließlich einen
OpenCollective-Spendenhinweis und erstellt keine OCR-Artefakte. Unbekannte
Build-Scripts führen weiterhin zum Installationsfehler. Die
SimpleWebAuthn-Versions- und Aufrufvertragsprüfungen des Gates bleiben davon
unberührt; diese technische Installationskorrektur ändert weder
Zugriffsentscheidungen noch die fachliche Bewertung dieser Regel.

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

Die PostgreSQL-Regression führt den tatsächlichen Sicherheitsprüfer gegen
isolierte Datenbanken aus. Sie prüft sichere Rechte vor und nach den stets
zurückgerollten Abweichungen, zusätzliche Audit-/Dokument-Schreibrechte
einschließlich Rolling Anchors, Prüf-Checkpoints und Anchor-Lease,
öffentliches TRUNCATE und Definer-Ausführung, erreichbare privilegierte
SET-ROLE-Ziele, fehlende Funktionsausführung, deaktiviertes oder nicht
erzwungenes RLS sowie neue ungeschützte normale und partitionierte Tabellen.
Probe-Units weisen fehlende, verkürzte und null-Ergebnisse sowie Queryfehler
ab und belegen, dass Restore-CLI und CI-Selbsttest dieselben 30 Invarianten
prüfen. Ein echter Dump-/Restore-Gegenlauf prüft jeweils mit und ohne optionalen
Datensmoke ein leeres Ziel und ein durch den CI-Bootstrap vorbereitetes Ziel:
identische Daten können unterschiedliche effektive Rechte haben; nur das
sichere Ziel darf Erfolg melden. Fehlende Rollen/Schemaobjekte, ausschließlich
fehlende Policies und ein vollständig leeres RLS-Inventar sind konservative
Fehlerpfade im Code, keine gesondert dynamisch nachgewiesenen Fälle.

Der Datenbanktest belegt Cross-Tenant-Sperren für Lesen, Einfügen, Aktualisieren
und Löschen sowie Paar-Guards ausgewählter Tabellen. Das Skript belegt den
Schema-Inventurmechanismus. Beides beweist nicht die Sicherheit privilegierter
Zugänge oder eine vollständige Angriffssimulation.

Die Ticket-Regression belegt tenantunabhängige Nummernkreise, parallele
automatische Nummernvergabe, den gemeinsamen Rollback von Zähler und Anlage
sowie den Erhalt vergebener Nummern nach tatsächlicher Löschung. Sie prüft
unveränderliche Identitäten, Archivzustände mit Abschlusszeit und handelnder
Person, gerichtete Referenzen ohne Selbst-/Cross-Tenant-Kanten und den
quellengebundenen Rechercheanker. Der reale Herkunfts-Fremdschlüssel setzt bei
Quelllöschung ausschließlich die Herkunftsspalte null, nicht den Tenant.
Ein separater Upgrade-Gegenlauf erhält alle bisherigen Ticketspalten und
vergibt Nummern deterministisch nach Erstellungszeit und UUID; mehrdeutige
aktuelle Markierungszeiger werden nicht als Herkunft übernommen.

Zusätzliche Restore-ACL-Proben entziehen notwendige Referenzrechte oder
vergeben unzulässige Zähler-, Referenz- und Funktionsrechte jeweils nur in
zurückgerollten Testtransaktionen. Ein echter PostgreSQL-Dump-/Restore-Gegenlauf
erhält Tickets einschließlich Archiv, Zähler und Referenzen bytewertgleich
in den verglichenen Spalten. Ein durch Defaultprivilegien vorbereitetes Ziel
mit erneut gewährten Zähler-/Referenz-Schreibrechten wird trotz gleicher
Datensätze abgewiesen; ein leeres Ziel mit erhaltenen Rechten besteht die
Abnahme. Owner-Fälle (fehlende, umbenannte oder mit zusätzlichen Rechten
versehene Owner-Rolle sowie ein Dump von vor S-01) brechen beide
Restore-Sicherheitsprüfungen mit eigener Meldung ab. Diese Tests ersetzen keine
Objektberechtigungsprüfung innerhalb einer Kanzlei; Referenzanzeige und Nummernauflösung brauchen weiterhin das
aktuelle Zugriffsgate für beide Tickets.

Ticketmutationen und Archivierung verwenden `FOR NO KEY UPDATE`: Der Lock
serialisiert Zustandsänderungen, lässt aber die `KEY SHARE`-Sperren der
Referenz-Fremdschlüssel zu. Zwei gleichzeitig geschriebene gegenseitige
Erwähnungen müssen beide committen können. Die PostgreSQL-Regression weist
für `FOR UPDATE` zuvor den Deadlock `40P01` nach und belegt mit dem schwächeren
Schreiblock zwei persistierte Kanten. Der parallele Archivtest belegt weiterhin,
dass ein wartender Schreiber nach Freigabe den neuen Archivzustand liest.

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
Größenlimit. Der CRL-Abruftest belegt die gesperrten Adressklassen für IPv4
und IPv6 samt gemappter Formen, die einmalige Auflösung trotz geänderter
zweiter DNS-Antwort, die gepinnte Verbindung, die Redirect-Sperre und den
Fail-close der Pfadprüfung. Migration und Laufzeittest belegen Singleton-/
Initialzustandsconstraints, den Tabellenrechteentzug der App-Rolle, die
transaktionale Installation des Policy-Guards, den eng gewährten Guard für das
exakte Tripel aus Serie, Policy-Revision und Policy-Hash sowie dessen
transaktionslangen Share-Lock. WebAuthn-Tests belegen außerdem
Serienübernahme vor dem lokalen Modellfilter, globale Deaktivierung,
Same-Revision-Drift, Übernahme einer höheren Revision und Abweisung älterer
Replikas. Das Supply-Chain-Gate belegt den exakten Versionspin und die
Härtungsmarker des Aufrufvertrags. Vertragstests gegen die echte Version
13.3.3 belegen, dass die Bibliothek ohne Wurzeln Attestation und
MDS-Signatur ohne Netzzugriff prüft, die eigene Kettenprüfung eine fremde
Kette abweist und bei ungültiger MDS-Signatur keine Sperrliste lädt. Sie
belegen auch, dass die Bibliothek mit Wurzeln die Sperrliste eines fremden
Zertifikats vor dem Kettenaufbau abrufen und eine unerreichbare Sperrliste
akzeptieren würde. Browser-Fehlertest und Ops-Test belegen die umschlossene
Abbrucherkennung sowie die Weitergabe der Deployment-Allowlist an den
App-Container.
