# ADR 0001 — Monorepo mit pnpm-Workspaces und Turborepo

**Status**: Akzeptiert
**Datum**: 2026-05-10

## Kontext

taxtronik besteht aus mindestens zwei Deployables (Next.js-App und BullMQ-Worker)
und mehreren geteilten Bibliotheken (DB-Schema, Auth-Konfig, Evidence-Service,
Storage-Wrapper, Job-Definitionen). Der Worker MUSS exakt dasselbe
Prisma-Schema, dieselben Zod-Schemas und dieselbe Audit-Logik nutzen wie die
App — sonst ist Drift garantiert.

## Entscheidung

- **Monorepo** mit allen Paketen in einem Repo (`apps/*`, `packages/*`).
- **pnpm-Workspaces** für Dependency-Management (`workspace:*`-Protokoll).
- **Turborepo** für die Task-Pipeline (`build`, `lint`, `typecheck`, `test`).
- **TypeScript-Path-Aliases** über `tsconfig.base.json` und Workspace-Namen.

## Konsequenzen

**Positiv**
- Eine Quelle der Wahrheit für Schemas, Types, Compliance-Logik.
- Atomare Commits über Schema- und App-Änderungen.
- Turbo-Caching beschleunigt CI deutlich (nur geänderte Pakete).
- Cheaper LLMs können fokussiert an einem Paket arbeiten, ohne
  Cross-Modul-Logik zu brechen.

**Negativ**
- Höhere Initial-Komplexität als ein einzelnes Next.js-Projekt.
- pnpm-Setup muss bei jeder neuen Maschine korrekt installiert sein
  (Node 20+, `corepack enable`).

## Alternativen

- **Multi-Repo**: verworfen — zu hohe Drift-Gefahr bei Schema-Änderungen,
  zu viel Versionierungs-Overhead.
- **Single-Project Next.js**: verworfen — Worker als zweites Deployable
  braucht eigenes Build-Artefakt; Foundation-Pakete sollen wiederverwendbar
  bleiben (z. B. CLI für Hash-Chain-Verifikation).

## Verifikation

`pnpm install && pnpm typecheck && pnpm lint` muss in einem frischen Clone
erfolgreich durchlaufen.
