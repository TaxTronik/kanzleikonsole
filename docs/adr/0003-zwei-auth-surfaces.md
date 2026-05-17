# ADR 0003 — Zwei Auth-Surfaces (Mitarbeiter vs Mandant)

**Status**: Akzeptiert
**Datum**: 2026-05-10

## Kontext

taxtronik hat zwei sehr unterschiedliche Identitätstypen:

| | Mitarbeiter (Staff) | Mandant (Client Contact) |
|---|---|---|
| Login-Methode | E-Mail + Passwort + TOTP (Pflicht) | Magic-Link (E-Mail) + opt. 2FA |
| Häufigkeit | Tägliche Nutzung | Sporadisch (Alle paar Wochen) |
| Compliance-Klasse | Personalakte | § 203 StGB Mandantendaten |
| Routing | `/staff/*` | `/portal/*` |
| Datenzugriff | Eigener Kanzlei-Mandant | Nur die ihm zugeordneten Daten |

Eine gemeinsame `users`-Tabelle mit `role`-Discriminator wäre möglich, aber:
- Magic-Link-Tokens dürften niemals für Staff-Konten ausgegeben werden.
- Audit-Logs lesen sich klarer mit getrennten FKs.
- Cookie-Verwechslung muss strukturell ausgeschlossen sein.

## Entscheidung

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

## Konsequenzen

**Positiv**
- Strukturell sicher gegen Cookie-/Token-Verwechslung.
- Audit-Log-Spalten `actor_type ∈ {STAFF, CLIENT_CONTACT, SYSTEM}` sind klar.
- Auth.js-Konfigurationen können unabhängig erweitert werden (z. B. Passkeys
  für Staff, ohne Portal-Flow zu beeinflussen).

**Negativ**
- Mehr Boilerplate als ein Single-Auth-Setup.
- "Unified Login" (selbe E-Mail in beiden Welten) ist NICHT vorgesehen —
  bei Bedarf später als explizites Feature mit Verknüpfungstabelle.

## Alternativen

- **Single User-Tabelle mit Discriminator**: verworfen (siehe Kontext).
- **Externer IdP (Keycloak)**: verworfen für MVP — zu hoher Betriebsaufwand
  bei On-Prem; später nachrüstbar (Auth.js OIDC-Provider).

## Verifikation

E2E-Test (folgt in Iter. 2):
1. Staff-Login setzt nur Staff-Cookie, nicht Portal.
2. Mit Staff-Cookie auf `/portal/*` → Redirect zu `/portal/login`.
3. Mit Portal-Cookie auf `/staff/*` → Redirect zu `/staff/login`.
4. Magic-Link-Token mit `aud: 'portal'` darf keinen Staff-Login erzeugen.
