import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * A Pages Router API route, for the one e2e check a route handler can no longer
 * make: that a HEAD's declared `content-length` survives the runtime padding an
 * empty body.
 *
 * Since 16.4.5 Next.js strips `content-length` from a route handler's
 * `Response` (`sendResponse`, GHSA-pc58-hwjq-p385), so `app/api/echo` declares
 * a length that never reaches the runtime. A Pages API route writes the Node
 * response itself, and `sendData` drops framing headers only for 204 and 304,
 * so the header set here is the one the runtime sees.
 *
 * The GET answers with the body the HEAD describes, so the two agree.
 */
const BODY = 'x'.repeat(42);

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('x-e2e-head-length', 'pages');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  if (req.method === 'HEAD') {
    res.setHeader('content-length', String(Buffer.byteLength(BODY)));
    res.status(200).end();
    return;
  }
  res.status(200).send(BODY);
}
