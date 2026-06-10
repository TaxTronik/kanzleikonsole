# Technische Modulbeschreibung: Zugriffsschutz und Benutzerverwaltung

## Zweck

Zwei strikt getrennte Anmeldekontexte (Kanzlei/Staff und Mandanten/Portal),
rollenbasierte Berechtigungen, Mandantentrennung in Tiefenstaffelung
(App-Guards + Postgres-RLS) und vollständige Anmelde-Protokollierung.

## Authentifizierung

- **Staff:** Passwort (bcrypt cost 12, min. 12 Zeichen bei Anlage) +
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
  Redis-Revocation (Deaktivierung/Rollenwechsel beendet Sitzungen sofort).

## Autorisierung

- Rollen: ADMIN/PARTNER (= Admin-Funktionen) / EMPLOYEE; min. 1 Rolle,
  Selbständerung gesperrt.
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
`staff.create/.roles.update/.activate/.deactivate/.skills.update`,
`client_contact.create/.update/.deactivate` — alle in der Hash-Chain.

## Traceability

| Anforderung | Implementierung | Test |
|---|---|---|
| Cross-Tenant unmöglich (DB-Ebene) | RLS-Policies | `rls-cross-tenant.test.ts` (CI-Pflicht) |
| Kein Owner-Fallback | db/client fail-closed | `client-fail-closed.test.ts` |
| Magic-Link-Lebenszyklus | auth/magic-link | `magic-link.test.ts` + Security-Audit 2026-06 (One-Time/Replay/Prefetch verifiziert) |
| Lockout ohne Fremd-Aussperrung | auth/lockout | `lockout.test.ts` |
| TOTP-Helfer | auth/totp | `totp.test.ts` |
| Zugriffspolicy-Wahrheitstabelle | settings/access-policy | `access-policy.test.ts` |
| Fehler ohne Internals | rbac.toActionError | `rbac.test.ts` |
| Open-Redirect-Schutz | safePortalReturnTo | `safe-return-to.test.ts` |
| GwG-Sperre Portal-Zugang | DB-Trigger + Session-Check | `gwg-allow-active.test.ts` + portal.ts-Revalidierung |
| Alle Actions geguarded | AST-Scan | `server-action-authz.test.ts` |

## Bekannte Grenzen

Kein Passwort-/TOTP-Reset-Flow für Bestandskonten (Workaround: Konto neu
anlegen — in der Anwenderdoku ausgewiesen); Passwort-Policy greift nur bei
Anlage (kein Änderungs-Flow); Sicherheitsmodell setzt auf TOTP-Zweitfaktor
statt Passwort-Ablauf/-Historie (bewusste, dokumentierte Entscheidung).
