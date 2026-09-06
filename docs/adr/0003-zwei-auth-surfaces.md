# ADR 0003 — Zwei Auth-Surfaces (Mitarbeiter vs Mandant)

**Status**: Kernentscheidung akzeptiert; Cookie-/Provider-Details am 2026-09-03 aktualisiert
**Datum**: 2026-05-10 · aktualisiert 2026-09-03

> **Aktueller Stand:** Die Trennung in Staff- und Portal-Identitäten sowie zwei
> Auth.js-Konfigurationen gilt weiter. Die ursprünglichen Cookie-, Provider-
> und Middleware-Details unten sind historisch: Beide Session-Cookies verwenden
> `Path=/`, `SameSite=Lax` und getrennte Namen; in Produktion greifen
> `__Host-` beziehungsweise bei expliziter Domain `__Secure-`. Staff und Portal
> verwenden getrennte Auth.js-Konfigurationen. Staff besitzt getrennte
> Credentials-Provider für Passwort/TOTP und den optionalen reinen
> Sicherheitsschlüssel-Zugang; der Portal-Provider verifiziert weiterhin
> ausschließlich einen eigenen gehashten One-Time-Magic-Link. Der pfadbasierte
> Vorschutz liegt in `apps/web/src/proxy.ts`, nicht in `middleware.ts`.

## Kontext

taxtronik hat zwei sehr unterschiedliche Identitätstypen:

|                   | Mitarbeiter (Staff)                                             | Mandant (Client Contact)               |
| ----------------- | --------------------------------------------------------------- | -------------------------------------- |
| Login-Methode     | Passwort + TOTP oder nach Opt-in nur physischer FIDO2-Schlüssel | gehashter Einmal-Magic-Link per E-Mail |
| Häufigkeit        | Tägliche Nutzung                                                | Sporadisch (Alle paar Wochen)          |
| Compliance-Klasse | Personalakte                                                    | § 203 StGB Mandantendaten              |
| Routing           | `/staff/*`                                                      | `/portal/*`                            |
| Datenzugriff      | Eigener Kanzlei-Mandant                                         | Nur die ihm zugeordneten Daten         |

Eine gemeinsame `users`-Tabelle mit `role`-Discriminator wäre möglich, aber:

- Magic-Link-Tokens dürften niemals für Staff-Konten ausgegeben werden.
- Audit-Logs lesen sich klarer mit getrennten FKs.
- Cookie-Verwechslung muss strukturell ausgeschlossen sein.

## Ursprüngliche Entscheidung (historisch)

- **Zwei separate Tabellen**: `staff_user` und `client_contact` (letzte
  kommt in Iter. 2).
- **Zwei Auth.js v5-Konfigurationen** in `apps/web/src/server/auth/{staff,portal}.ts`.
- **Zwei Cookies**:
  - `__taxtronik_staff_session` mit `Path=/staff`
  - `__taxtronik_portal_session` mit `Path=/portal`
  - Beide `HttpOnly`, `Secure`, `SameSite=Strict`.
  - Cookie-`Path`-Trennung verhindert versehentlichen Cross-Submit.
- **Middleware** (`apps/web/src/middleware.ts`) prüft pfad-basiert:
  - `/staff/*` → Staff-Cookie nötig, sonst Redirect zu `/staff/login`
  - `/portal/*` → Portal-Cookie nötig, sonst Redirect zu `/portal/login`
- **Optional Subdomain-Trennung**: `kanzlei.example.com` (Staff) vs
  `portal.kanzlei.example.com` (Portal). Kanzlei-Admin entscheidet beim Setup.
  Vermeidet jede Cookie-Kreuzkontamination.
- **Magic-Link-Tokens** (Iter. 2) tragen `aud: 'portal'` als Audience-Claim.
  Auth.js Email-Adapter prüft das beim Verify; ein für Portal ausgestellter
  Token kann niemals einen Staff-Login auslösen.

## Fortgeltende Konsequenzen

**Positiv**

- Strukturell sicher gegen Cookie-/Token-Verwechslung.
- Audit-Log-Spalten `actor_type ∈ {STAFF, CLIENT_CONTACT, SYSTEM}` sind klar.
- Auth.js-Konfigurationen können unabhängig erweitert werden. Der optionale
  Staff-Modus „Nur physische FIDO2-Sicherheitsschlüssel“ beeinflusst weder
  Portal-Identitäten noch Magic-Link-Token oder Portal-Sessions.

**Negativ**

- Mehr Boilerplate als ein Single-Auth-Setup.
- "Unified Login" (selbe E-Mail in beiden Welten) ist NICHT vorgesehen —
  bei Bedarf später als explizites Feature mit Verknüpfungstabelle.
- Der optionale Staff-Hardwarepfad besitzt mit Deployment-AAGUID-Allowlist und
  FIDO MDS eine zusätzliche externe Trust-/Verfügbarkeitsgrenze. Sein
  fail-closed Ausfall beeinflusst den getrennten Portal-Magic-Link nicht.

## Alternativen

- **Single User-Tabelle mit Discriminator**: verworfen (siehe Kontext).
- **Externer IdP (Keycloak)**: verworfen für MVP — zu hoher Betriebsaufwand
  bei On-Prem; später nachrüstbar (Auth.js OIDC-Provider).

## Verifikation

Die Trennung wird durch Auth-/E2E-Tests verifiziert:

1. Staff-Login setzt nur Staff-Cookie, nicht Portal.
2. Mit Staff-Cookie auf `/portal/*` → Redirect zu `/portal/login`.
3. Mit Portal-Cookie auf `/staff/*` → Redirect zu `/staff/login`.
4. Magic-Link-Token mit `aud: 'portal'` darf keinen Staff-Login erzeugen.
5. Hardware-only akzeptiert nur den Staff-Sicherheitsschlüssel-Provider;
   Passwort, TOTP und Backup-Code bleiben für dieses Konto gesperrt.
6. Aktivierung, Deaktivierung und Recovery eines Staff-Hardwarezugangs ändern
   keinen Portal-Loginpfad und widerrufen keine Portal-Sitzung.
7. Leere Hardware-AAGUID-Allowlist, nicht vertrauenswürdiges MDS-Statement oder
   MDS-/Netzausfall blockieren Staff-Hardware-Assertions, nicht aber
   Passwort/TOTP-Konten oder Portal-Magic-Links.
