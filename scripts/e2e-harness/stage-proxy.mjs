#!/usr/bin/env node
/**
 * A localhost front door for a `NextjsRegionalFunctions` harness stack, which
 * puts the API Gateway stage back into every request path.
 *
 *   node stage-proxy.mjs <port> <target>
 *   node stage-proxy.mjs 43210 https://abc123.execute-api.us-east-1.amazonaws.com/prod
 *
 * Why it has to exist: a REST API's execute-api URL always carries the stage
 * (`.../prod`), and next.js's harness discards any path in the deployment URL —
 * `getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname` outright — so
 * every absolute path the suite requests would miss the stage and get a 403 from
 * API Gateway. The fixtures are written against a deployment served at the
 * origin root, which is what this presents: `http://127.0.0.1:<port>/foo` goes to
 * `<target>/foo`.
 *
 * The app is deployed *without* a `basePath`, because the fixtures set their own
 * or none. API Gateway strips the stage again before invoking the Lambda, so the
 * app sees the same paths it would at a root-mapped custom domain — which is the
 * setup `examples/regional-functions/README.md` recommends for production.
 *
 * The response goes back unchanged except for `Location`: an absolute one naming
 * the target, or this origin over `https`, is rewritten to this origin, so the harness follows redirects here
 * rather than to a URL whose stage it would then strip. Bodies stream both ways,
 * so a streamed render is observed as streamed.
 *
 * Plain Node, no dependencies: `e2e-deploy.sh` starts it detached and it outlives
 * that script, serving every test file the shared stack hosts.
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const [portArg, targetArg] = process.argv.slice(2);
if (!portArg || !targetArg) {
  console.error("usage: stage-proxy.mjs <port> <target-url-with-stage>");
  process.exit(2);
}
const port = Number(portArg);
const target = new URL(targetArg);
// No trailing slash: request paths are absolute and supply their own.
const stagePrefix = target.pathname.replace(/\/+$/, "");
const targetOrigin = `${target.protocol}//${target.host}`;
const send = target.protocol === "https:" ? httpsRequest : httpRequest;

/** Hop-by-hop headers (RFC 9110 §7.6.1), which a proxy must not forward. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

function forwardable(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

const server = createServer((req, res) => {
  const localOrigin = `http://${localHost(req)}`;
  const headers = forwardable(req.headers);
  // API Gateway routes on the Host header and TLS on SNI, so both have to name
  // the target - which is not the origin the browser is on. `x-forwarded-host`
  // carries that one, and both Next.js and cdk-nextjs's runtime prefer it over
  // `host`: without it, a server action's CSRF check compares the browser's
  // `Origin` (`127.0.0.1:<port>`) against the execute-api host and aborts, and a
  // `redirect()` to `location.origin + ...` reads as external. API Gateway sets
  // `x-forwarded-proto: https` over ours, so absolute URLs the app builds come
  // back as `https://127.0.0.1:<port>`; `rewriteLocation` fixes those up.
  //
  // What no header can fix: a fetch the *server* makes to its own origin (a
  // server action streaming its redirect target, for one). It leaves the Lambda
  // for 127.0.0.1, which is not this machine from there. That is the price of a
  // local front door, and why such a test failing here is not a product defect.
  headers.host = target.host;
  headers["x-forwarded-host"] = localHost(req);

  const upstream = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      // `req.url` is the raw request target, still percent-encoded and with any
      // repeated slashes intact: what the suite sent is what the app should see.
      path: `${stagePrefix}${req.url}`,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = forwardable(upstreamRes.headers);
      const location = upstreamRes.headers.location;
      if (typeof location === "string") {
        responseHeaders.location = rewriteLocation(location, localOrigin);
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    console.error(`stage-proxy: ${req.method} ${req.url}:`, error.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`stage-proxy: ${error.message}`);
  });
  req.pipe(upstream);
});

/**
 * An absolute `Location` on the target — with or without the stage — comes back
 * on this origin. A relative one needs nothing: the app sees no stage, so it
 * never emits one.
 */
function rewriteLocation(location, localOrigin) {
  const httpsLocal = localOrigin.replace(/^http:/, "https:");
  for (const prefix of [
    `${targetOrigin}${stagePrefix}`,
    targetOrigin,
    httpsLocal,
  ]) {
    if (location === prefix || location.startsWith(`${prefix}/`)) {
      return `${localOrigin}${location.slice(prefix.length) || "/"}`;
    }
  }
  return location;
}

/** The authority the client addressed this proxy by. */
function localHost(req) {
  return req.headers.host ?? `127.0.0.1:${port}`;
}

server.listen(port, "127.0.0.1", () => {
  console.error(
    `stage-proxy: http://127.0.0.1:${port} -> ${targetOrigin}${stagePrefix}`,
  );
});
