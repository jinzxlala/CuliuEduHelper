import { NextResponse } from "next/server";

import { buildWebReadiness } from "../../../lib/readiness";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const readiness = await buildWebReadiness();
  return NextResponse.json(readiness, {
    headers: { "Cache-Control": "no-store" },
    status: readiness.status === "ready" ? 200 : 503,
  });
}
