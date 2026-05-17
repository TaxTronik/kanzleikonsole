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
nutzen `env.NEXTAUTH_URL` als Basis. Wenn Staff- und Portal-URL getrennt
sind, sollte die Mail-Generierung explizit die richtige URL pro Empfängertyp
wählen:

| Mail | Empfänger | Basis-URL |
|---|---|---|
| Magic-Link Portal-Login | Mandant | Portal-Subdomain |
| GwG-Onboarding | Mandant | Portal-Subdomain |
| PoA-Sign | Mandant | Portal-Subdomain |
| Staff-Reset-Link (zukünftig) | Mitarbeiter | Staff-Subdomain |

Aktueller Code nutzt nur `NEXTAUTH_URL` — Erweiterung mit
`PORTAL_PUBLIC_URL` und `STAFF_PUBLIC_URL` als optionale Overrides ist
ein offener Punkt (siehe IDEAS.md).

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
Cookie-Namen (`__taxtronik_staff_session` vs `__taxtronik_portal_session`)
mit `Path=/` bietet weiterhin saubere Surface-Isolation, nur eben auf
Cookie-Pfad-Ebene statt Subdomain-Ebene.
