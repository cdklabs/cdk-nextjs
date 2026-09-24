import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';

/**
 * One route handler covering the response and request shapes that the four
 * cdk-nextjs deployment types plumb differently. Deliberately one file rather
 * than nine: every branch here reads `request`, so none of them needs
 * `connection()` to stay out of the build-time prerender, and keeping them
 * together makes the set of shapes readable in one place.
 *
 * What is actually being tested, per branch:
 *
 * - `?bytes=N` A body that cannot be compressed. `src/runtime/http/sink.ts`
 *   gzips `text/*` itself, because neither API Gateway (which drops
 *   `content-encoding` in STREAM mode) nor CloudFront (which needs a
 *   `content-length`) can compress a streamed response for us - so a text body of
 *   any size collapses to kilobytes and proves nothing about size limits. An
 *   `application/octet-stream` body does not compress, and at 5 MiB its base64
 *   encoding is ~6.7 MB, past Lambda's 6 MB *buffered* cap. If anything ever
 *   reverts to a buffered response this branch is where it fails.
 * - `?empty=1` A zero-payload response. This one has bitten twice: a Lambda
 *   Function URL discarded the whole streaming prelude and answered a bare `200
 *   application/octet-stream` with none of the app's headers, and API Gateway
 *   answered `502`. `padEmptyBody` in the sink writes a single space to stop it,
 *   which is why a test here asserts one byte or fewer rather than zero.
 * - `?cookies=N` Several `Set-Cookie`s on one response. They are carried in the
 *   prelude's `cookies` array on the Lambda shells and as a real repeated header
 *   on the containers, and a comma-joined `Set-Cookie` is indistinguishable from
 *   a single malformed one to a browser.
 * - `?stream=1` A body that arrives in pieces over time, which is the only way
 *   to catch an integration that buffers the whole response before sending.
 * - `?throw=1` / `?notfound=1` The error and 404 paths *out of a route handler*,
 *   which reach different code than a page's do.
 * - `POST` / `PUT` A request body. Behind CloudFront + a signed Function URL the
 *   body has to be hashed into the SigV4 signature; on API Gateway it arrives
 *   base64-encoded; on a container it arrives as a plain stream. Three code paths
 *   for one thing.
 */

const MARKER = 'x-e2e-echo';

/** Cap what a single request can allocate here. 8 MiB is past Lambda's 6 MB
 * buffered-response cap, which is the largest thing worth asking for. */
const MAX_BYTES = 8 * 1024 * 1024;

function sha256(body: Uint8Array | string) {
  return createHash('sha256').update(body).digest('hex');
}

function markerHeaders(extra?: Record<string, string>) {
  return { [MARKER]: 'echo', ...extra };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  if (params.has('throw')) {
    // Not a `new Response(..., { status: 500 })`: the point is an *unhandled*
    // throw out of the handler, so the runtime's error ladder is what answers.
    throw new Error('e2e: deliberate route handler throw');
  }

  if (params.has('notfound')) {
    notFound();
  }

  const status = Number(params.get('status') ?? '');
  if (status) {
    return new NextResponse(`status ${status}`, {
      status,
      headers: markerHeaders({ 'content-type': 'text/plain; charset=utf-8' }),
    });
  }

  if (params.has('empty')) {
    // A 204 carries no body by definition, so this is the response where a lost
    // prelude leaves nothing at all to look at except the headers - which is
    // exactly why the marker header is asserted rather than the body.
    return new NextResponse(null, { status: 204, headers: markerHeaders() });
  }

  if (params.has('readcookies')) {
    // The inbound direction. Read through Next.js's own `cookies()` rather than
    // the raw header, because that is what an app uses and it is the API that
    // silently returns fewer cookies than were sent when the header was rebuilt
    // with the wrong separator.
    const jar = await cookies();
    return NextResponse.json(
      { cookies: jar.getAll().map((c) => c.name) },
      { headers: markerHeaders() },
    );
  }

  const cookieCount = Number(params.get('cookies') ?? '');
  if (cookieCount) {
    const response = new NextResponse(`set ${cookieCount} cookies`, {
      headers: markerHeaders({ 'content-type': 'text/plain; charset=utf-8' }),
    });
    for (let i = 1; i <= cookieCount; i++) {
      // `append`, not `set`: `set` would collapse these into one header and the
      // test would pass against a runtime that cannot emit repeated ones.
      response.headers.append(
        'set-cookie',
        `e2e-cookie-${i}=value-${i}; Path=/; SameSite=Lax`,
      );
    }
    return response;
  }

  if (params.has('stream')) {
    const chunks = ['chunk-1\n', 'chunk-2\n', 'chunk-3\n'];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          // Long enough that a buffering integration has to wait for it, short
          // enough not to matter to the suite's wall clock.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        controller.close();
      },
    });
    return new NextResponse(stream, {
      // `text/plain` on purpose: this is also the only test of the sink gzipping
      // a *streamed* text body, which it has to do itself.
      headers: markerHeaders({
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      }),
    });
  }

  const requested = Number(params.get('bytes') ?? '');
  if (requested) {
    const size = Math.min(Math.max(requested, 0), MAX_BYTES);
    // Random rather than a repeating pattern: a pattern gzips to nothing, and
    // then the branch no longer measures what it was written for.
    const body = randomBytes(size);
    return new NextResponse(new Uint8Array(body), {
      headers: markerHeaders({
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        // The test hashes what it received and compares - a truncated or
        // re-encoded body fails here rather than looking like a length mismatch.
        'x-e2e-body-sha256': sha256(body),
      }),
    });
  }

  return NextResponse.json(
    { method: 'GET', url: request.nextUrl.pathname },
    { headers: markerHeaders() },
  );
}

/**
 * Echoes back what the body looked like on arrival. `bodySha256` is the
 * assertion that matters: a body that survived the edge signature check but was
 * re-encoded or truncated on the way in still has the right length surprisingly
 * often.
 */
async function echoRequestBody(request: NextRequest, method: string) {
  const body = new Uint8Array(await request.arrayBuffer());
  return NextResponse.json(
    {
      method,
      contentType: request.headers.get('content-type'),
      bodyLength: body.byteLength,
      bodySha256: sha256(body),
    },
    { headers: markerHeaders() },
  );
}

export async function POST(request: NextRequest) {
  return echoRequestBody(request, 'POST');
}

export async function PUT(request: NextRequest) {
  return echoRequestBody(request, 'PUT');
}

export function DELETE(request: NextRequest) {
  // Second empty-body case, reached by method rather than by query, because the
  // Lambda shells build the response prelude per method. Each of these reflects
  // the request's own path back so the handler genuinely depends on the request
  // and cannot be answered from a build-time prerender.
  return new NextResponse(null, {
    status: 204,
    headers: markerHeaders({ 'x-e2e-path': request.nextUrl.pathname }),
  });
}

export function HEAD(request: NextRequest) {
  // A HEAD has no body but must still declare the length the GET would have had.
  // Answering it as a zero-byte streamed response is the `padEmptyBody` case
  // again, with the extra wrinkle that API Gateway declares only `GET` on the
  // static-asset resources - so this is deliberately a *dynamic* route, not an
  // asset.
  return new NextResponse(null, {
    status: 200,
    headers: markerHeaders({
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '42',
      'x-e2e-path': request.nextUrl.pathname,
    }),
  });
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: markerHeaders({
      allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'x-e2e-path': request.nextUrl.pathname,
    }),
  });
}
