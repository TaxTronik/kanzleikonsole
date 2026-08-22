# Technische Modulbeschreibung: Zugriffsschutz und Benutzerverwaltung

## Zweck

Zwei strikt getrennte Anmeldekontexte (Kanzlei/Staff und Mandanten/Portal),
rollenbasierte Berechtigungen, Mandantentrennung in Tiefenstaffelung
(App-Guards + Postgres-RLS) und vollständige Anmelde-Protokollierung.

## Authentifizierung

- **Staff:** Passwort (bcrypt cost 12, min. 12 Zeichen bei Anlage und Änderung) +
  **TOTP-Pflicht** (Self-Enrollment beim Erstlogin, 60-min-Fenster,
  serverseitig erzeugter QR; Secret verschlüsselt; 8 einmalige
  Backup-Codes, bcrypt-gehasht, atomarer Konsum; TOTP-Replay-Schutz via
  Redis SET NX, fail-closed).
- **Portal:** ausschließlich Magic-Link (32-Byte-Token, nur SHA-256-Hash in
  DB, 30 min TTL, atomarer One-Time-Consume in einer Tx mit Audit,
  POST-Consume gegen Mail-Scanner-Prefetch, Anti-Enumeration mit
  Zufalls-Latenz, Versand-Throttle).
- **Lockout/Rate-Limits:** IP-Limits je Login-Schritt; Kontosperre erst bei
  Fehlversuchen von ≥5 **distinkten** Quell-IPs (kein Fremd-Lockout);
  fail-closed bei Redis-Ausfall in Produktion; X-Forwarded-For wird ohne
  `TRUST_PROXY_REQUIRED` nicht vertraut.
- **Sessions:** `__Host-`-Cookies, getrennte Auth.js-Instanzen je Surface,
  per-Request-Revalidierung (aktiv? GwG-Freigabe? anonymisiert?),
  Redis-Revocation (Deaktivierung, Rollen-, Passwort- oder 2FA-Reset beendet
  Sitzungen sofort).
- **Kontowiederherstellung:** Jeder Mitarbeiter kann sein Passwort im eigenen
  Benutzerprofil nach Prüfung des bisherigen Passworts ändern (Rate-Limit,
  Bestätigung, anschließender Logout auf allen Geräten). ADMIN können fremde
  PARTNER-/EMPLOYEE-Passwörter und -TOTP-Zuordnungen zurücksetzen, PARTNER nur
  die von EMPLOYEE. Secret, offenes Setup und Backup-Codes werden gemeinsam
  entfernt. ADMIN-Konten sind von den Web-Resets ausgeschlossen; Passwort und
  TOTP werden ausschließlich über `reset-admin-password` per Owner-CLI
  wiederhergestellt. `ADMIN_EMAIL` und `TENANT_SLUG` sind dabei verpflichtend;
  die CLI mutiert nur bei genau einem Treffer und bricht sonst fail-closed ab.

## Autorisierung

- Rollen: ADMIN/PARTNER (= allgemeine Admin-Funktionen) / EMPLOYEE; min. 1
  Rolle, Selbständerung gesperrt. Kontowiederherstellung und Verwaltung der
  ADMIN-Rolle folgen zusätzlich einer serverseitigen Hierarchie: PARTNER
  können keine ADMIN-Konten deaktivieren oder ADMIN-Rollen vergeben/ändern.
- **Einzelrechte (iter87):** `staff_permission` je Mitarbeiter —
  `INVOICE_MANAGE` (Rechnungen anlegen/bearbeiten, Zahlung/Storno),
  `INVOICE_SEND` (versenden = Festschreibung, EXTERNAL-Upload),
  `ABSENCE_DECIDE` (Urlaub entscheiden, Abwesenheitsmeldungen erhalten).
  ADMIN/PARTNER implizit alles (`hasStaffPermission`); Durchsetzung im
  zentralen Gate (`staffActionGuard({ requirePermission })`), UI-Ausblendung
  ist nur Komfort. Vergabe/Entzug Admin-only, Selbständerung gesperrt,
  Entzug beendet Sitzungen sofort (Revocation + per-Request-Frischladung
  der Rechte aus der DB). Update-Migration verteilt `INVOICE_*` an alle
  Bestandsmitarbeiter (auch deaktivierte — sie behalten die Rechte bei
  späterer Reaktivierung; kein Verhaltensbruch), `ABSENCE_DECIDE` bleibt
  bei Admin/Partner bis zur expliziten Delegation.
- Mandantenzugriff: Policy OPEN (alle aktiven Staff außer vertrauliche
  Mandanten) oder RESTRICTED (nur Zuständige laut `ClientResponsibility`);
  zentral `canAccessClient(Tx)` + `inaccessibleClientIdsFor` für Mengen.
- **RLS-Backstop:** App-Rolle `taxtronik_app` ohne BYPASSRLS; jede Query
  via `withTenantContext` (`set_config('app.current_tenant_id', …)`) gegen
  FORCE-RLS-Policies; Owner-Verbindung nur Migration/CLI/Worker; App-Client
  fail-closed ohne Owner-Fallback.
- Maschinelle Guards: alle ~225 Server-Actions müssen ein Auth-Primitiv
  referenzieren (AST-Test), jede `new PrismaClient`-Stelle steht auf einer
  begründeten Allowlist.

## Protokollierung

`auth.login`(+Methode)/`auth.login.failure`/`auth.login.lockout`,
`auth.totp.enroll`, `auth.backup_code.consume`, `auth.magic_link.consume`,
`staff.create/.roles.update/.permissions.update/.activate/.deactivate/.skills.update`,
`staff.password.change/.password.reset/.totp.reset`,
`client_contact.create/.update/.deactivate` — alle in der Hash-Chain.

## Traceability

| Anforderung                               | Implementierung                            | Test                                                                                  |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Cross-Tenant unmöglich (DB-Ebene)         | RLS-Policies                               | `rls-cross-tenant.test.ts` (CI-Pflicht)                                               |
| Kein Owner-Fallback                       | db/client fail-closed                      | `client-fail-closed.test.ts`                                                          |
| Magic-Link-Lebenszyklus                   | auth/magic-link                            | `magic-link.test.ts` + Security-Audit 2026-06 (One-Time/Replay/Prefetch verifiziert)  |
| Lockout ohne Fremd-Aussperrung            | auth/lockout                               | `lockout.test.ts`                                                                     |
| TOTP-Helfer                               | auth/totp                                  | `totp.test.ts`                                                                        |
| Passwort-/2FA-Kontowiederherstellung      | profile + admin/users actions              | `profile/__tests__/actions.test.ts` + `admin/users/__tests__/account-actions.test.ts` |
| Zugriffspolicy-Wahrheitstabelle           | settings/access-policy                     | `access-policy.test.ts`                                                               |
| Einzelrechte (implizit/Grant/fail-closed) | rbac.hasStaffPermission + decideStaffGuard | `rbac.test.ts` + `staff-action.test.ts` (Wahrheitstabellen)                           |
| Fehler ohne Internals                     | rbac.toActionError                         | `rbac.test.ts`                                                                        |
| Open-Redirect-Schutz                      | safePortalReturnTo                         | `safe-return-to.test.ts`                                                              |
| GwG-Sperre Portal-Zugang                  | DB-Trigger + Session-Check                 | `gwg-allow-active.test.ts` + portal.ts-Revalidierung                                  |
| Alle Actions geguarded                    | AST-Scan                                   | `server-action-authz.test.ts`                                                         |

## Bekannte Grenzen

Es gibt bewusst keinen automatischen Passwort-Ablauf und keine Passwort-
Historie. Ein Benutzer kann seine bestehende TOTP-Zuordnung nicht selbst
entfernen. Bei Verlust von Authenticator und Backup-Codes erfolgt der
auditierte Web-Reset durch eine übergeordnete Rolle; für ADMIN-Konten ist
bewusst ausschließlich die Operator-CLI vorgesehen.
