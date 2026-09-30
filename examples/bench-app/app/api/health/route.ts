import { NextResponse } from 'next/server';

// The Containers constructs' healthCheckPath (examples/load-tests/stacks/app.ts)
export function GET() {
  return NextResponse.json('');
}
