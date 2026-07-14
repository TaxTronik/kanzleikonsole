import { NextResponse } from 'next/server';

/**
 * Reine Prozess-Liveness für Docker/Orchestratoren.
 *
 * Dieser Endpoint berührt bewusst keine externen Abhängigkeiten. Die
 * dependency-aware Readiness bleibt unter /api/health; dadurch führt etwa ein
 * Postgres-Ausfall nicht zu einem zusätzlichen Container-Restart-Loop.
 */
export function GET() {
  return NextResponse.json(
    { status: 'alive' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
