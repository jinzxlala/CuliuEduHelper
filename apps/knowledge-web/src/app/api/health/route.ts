import { NextResponse } from "next/server";

import { buildWebHealth } from "../../../lib/health";

export function GET(): NextResponse {
  return NextResponse.json(buildWebHealth());
}
