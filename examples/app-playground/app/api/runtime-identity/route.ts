import { connection } from 'next/server';
import { runtimeIdentity } from '../../../lib/runtime-identity';

export async function GET() {
  // Read at request time, not baked into a prerender. With `cacheComponents` the
  // route segment config `dynamic = 'force-dynamic'` is rejected, and nothing
  // else here touches the request - `process.env` does not count - so without
  // this Next.js would prerender the response at build time and every function
  // would report the same, empty identity.
  await connection();
  return runtimeIdentity();
}
