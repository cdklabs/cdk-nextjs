import { runtimeIdentity } from '../../lib/runtime-identity';

// Read at request time, not baked into a prerender.
export const dynamic = 'force-dynamic';

export function GET() {
  return runtimeIdentity();
}
