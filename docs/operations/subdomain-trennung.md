# Subdomain-Trennung Staff/Portal

Für produktive Kanzleien empfohlenes Setup: Mitarbeiter- und Mandanten-Surface
laufen auf getrennten Subdomains. Dadurch können die Surfaces unabhängig
zugänglich gemacht werden (z. B. Portal aus dem Internet, Staff nur aus dem
Kanzlei-LAN).

```
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ staff.kanzlei.example.de     │       │ portal.kanzlei.example.de    │
│ ────────────────────────     │       │ ────────────────────────     │
│ /staff/* + /api/staff/*      │       │ /portal/* + /api/portal/*    │
│ /api/auth/staff/*            │       │ /api/auth/portal/*           │
│ /api/n8n/* (HMAC)            │       │ /poa/sign, /gwg-onboarding   │
└──────────────┬───────────────┘       └──────────────┬───────────────┘
               │                                      │
               └────────────┬─────────────────────────┘
                            ▼
                ┌─────────────────────────┐
                │ Reverse-Proxy (Caddy)   │
                │ (TLS-Termination)       │
                └────────────┬────────────┘
                             ▼
                    ┌─────────────────┐
                    │ Next.js (3000)  │
                    └─────────────────┘
```

## Schritte

### 1. DNS

Zwei A-/AAAA-Records auf den Server der Kanzlei zeigen lassen:

```
staff.kanzlei.example.de.   IN A   <server-ip>
portal.kanzlei.example.de.  IN A   <server-ip>
```

### 2. Reverse-Proxy (Caddy-Beispiel)

```caddy
staff.kanzlei.example.de {
  encode gzip
  # Nur Staff-Pfade durchreichen — Portal-Pfade werfen 404
  @staffPaths path /staff/* /api/staff/* /api/auth/staff/* /api/n8n/* /api/health /_next/* /favicon.* /static/*
  handle @staffPaths {
    reverse_proxy localhost:3000
  }
  handle {
    respond "Not Found" 404
  }
}

portal.kanzlei.example.de {
  encode gzip
  @portalPaths path /portal/* /api/portal/* /api/auth/portal/* /poa/sign /poa/sign* /gwg-onboarding /gwg-onboarding* /api/health /_next/* /favicon.* /static/*
  handle @portalPaths {
    reverse_proxy localhost:3000
  }
  handle {
    respond "Not Found" 404
  }
}
```

> Wenn Mitarbeiter auch GwG-Onboarding-Links versenden, müssen die
> Wizard-Routen (`/gwg-onboarding`) sowohl auf Staff- als auch auf
> Portal-Subdomain erreichbar sein — die obige Caddy-Konfig erlaubt das
> nur über die Portal-Subdomain. Empfehlung: in den Mail-Templates
> immer die Portal-URL verwenden (= `NEXTAUTH_URL` der Portal-Subdomain).

### 3. ENV-Variablen

```env
# Staff-Subdomain als Haupt-URL
NEXTAUTH_URL=https://staff.kanzlei.example.de

# Mandanten-Links (Portal-Login, GwG-Onboarding, PoA-Signatur)
PORTAL_PUBLIC_URL=https://portal.kanzlei.example.de

# Cookie-Domains pro Surface — Subdomain-spezifisch (NICHT die Hauptdomain!)
STAFF_COOKIE_DOMAIN=staff.kanzlei.example.de
PORTAL_COOKIE_DOMAIN=portal.kanzlei.example.de
```

> **Wichtig:** Trage NIEMALS die übergeordnete Domain (z. B.
> `.kanzlei.example.de`) in beide ein. Sonst werden beide Cookies an
> beide Subdomains geschickt — die Surface-Trennung wäre kaputt.
>
> Wenn die `*_COOKIE_DOMAIN`-Variablen leer bleiben, sind die Cookies
> host-only, was im Subdomain-Setup ebenfalls die richtige Trennung gibt
> (jedes Cookie nur für seine Subdomain).

### 4. Mail-Links

Magic-Links für Portal-Login, GwG-Onboarding-Einladungen, PoA-Signatur etc.
nutzen `PORTAL_PUBLIC_URL` als Basis. `NEXTAUTH_URL` bleibt die Staff-/App-Basis
für Server-Callbacks und das Kanzlei-UI:

| Mail                         | Empfänger   | Basis-URL           |
| ---------------------------- | ----------- | ------------------- |
| Magic-Link Portal-Login      | Mandant     | `PORTAL_PUBLIC_URL` |
| GwG-Onboarding               | Mandant     | `PORTAL_PUBLIC_URL` |
| PoA-Sign                     | Mandant     | `PORTAL_PUBLIC_URL` |
| Staff-Reset-Link (zukünftig) | Mitarbeiter | Staff-Subdomain     |

Der aktuelle Code nutzt `PORTAL_PUBLIC_URL` für mandantengerichtete Links und
fällt nur im Single-Host-Setup auf `NEXTAUTH_URL` zurück.

### 4.1 n8n

n8n kann als lokaler Compose-Service laufen oder hinter einem eigenen VHost
stehen. Für die App ist entscheidend:

```env
N8N_WEBHOOK_BASE_URL=http://n8n:5678/webhook
N8N_HMAC_SECRET=<identisch in App, Worker und n8n>
```

In n8n selbst:

```env
TAXTRONIK_API_URL=https://staff.kanzlei.example.de
N8N_HMAC_SECRET=<identisch>
```

`TAXTRONIK_API_URL` darf auch eine interne URL sein (z. B.
`http://app:3000` im Compose-Netz). Extern erreichbare n8n-Calls gehen nur auf
`/api/n8n/*`; diese Endpunkte sind HMAC-signiert und gehören im Split-Setup auf
die Staff/API-Seite, nicht auf das öffentliche Mandantenportal.

### 5. Firewall (optional)

Bei einem Setup mit Staff-Surface nur intern:

```
staff.kanzlei.example.de   → nur aus 192.168.x.x erreichbar
portal.kanzlei.example.de  → öffentlich erreichbar (über Reverse-Proxy)
```

Realisierung am Reverse-Proxy oder in der Firewall — taxtronik selbst
hat keine IP-basierte Zugriffssteuerung (bewusst, weil das Reverse-Proxy-
Verantwortung ist).

## Single-Host-Fallback (Default)

Wenn keine Subdomain-Trennung gewünscht ist:

```env
NEXTAUTH_URL=https://taxtronik.kanzlei.example.de
# STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN bleiben leer
```

Die path-basierte Trennung (`/staff/*` vs `/portal/*`) plus die getrennten
Cookie-Namen (`__Host-taxtronik_staff_session` vs
`__Host-taxtronik_portal_session`) mit `Path=/` bietet weiterhin saubere
Surface-Isolation, nur eben auf Cookie-Pfad-Ebene statt Subdomain-Ebene.

**Cookie-Präfix-Logik** (`apps/web/src/server/auth/session-cookie.ts`): In
Production ohne Cookie-Domain tragen die Session-Cookies das `__Host-`-Präfix
(Browser erzwingen Secure + `Path=/` + kein Domain-Attribut — kein
Überschreiben durch Subdomains). Mit gesetzter `STAFF_COOKIE_DOMAIN` /
`PORTAL_COOKIE_DOMAIN` (Subdomain-Trennung) heißen sie
`__Secure-taxtronik_*_session`, weil `__Host-` kein Domain-Attribut erlaubt.
Im Dev (HTTP) bleibt der unpräfixte Name `__taxtronik_*_session`.
