import { test, expect } from "@playwright/test";

/**
 * Repeated `Set-Cookie` on the way out, and repeated `Cookie` on the way in.
 *
 * `Set-Cookie` is the one header that must never be folded into a comma-separated
 * list, and every layer here handles it specially for a different reason: the
 * Lambda shells put cookies in the response stream's prelude `cookies` array,
 * the container shell passes an array straight to `writeHead`, and the runtime
 * splits them back apart on the way in because `Headers.entries()` yields
 * `set-cookie` once per cookie and re-appending them would emit N² of them.
 *
 * Coverage today is shims only - no deployment has ever been asked to emit three
 * real cookies. There is no green file in the Next.js harness matching `cookies`
 * or `set-cookie` either.
 *
 * The prelude's `cookies` array reads like Function-URL payload-v2 semantics, which
 * would make it a coin toss on `NextjsRegionalFunctions`. It is not: API Gateway's
 * streaming metadata format documents exactly four keys - `headers`,
 * `multiValueHeaders`, `cookies`, `statusCode` - so one prelude is correct for both
 * integrations, and `responseTransferMode: STREAM` (`nextjs-api.ts`) is what makes
 * it apply. See
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
 *
 * What silently breaks: a comma-joined `Set-Cookie` looks like one malformed
 * cookie to a browser, so sessions, auth and draft mode all stop working with
 * nothing in any log.
 */
test.describe("cookies", () => {
  test("emits three Set-Cookie headers as three headers", async ({
    request,
  }) => {
    const response = await request.get("./api/echo?cookies=3");
    expect(response.status()).toBe(200);

    // `headersArray()`, not `headers()`: the latter flattens repeated headers into
    // one comma-joined string, which is exactly the bug being tested for - the
    // assertion would pass against a runtime that emitted a single folded header.
    const setCookies = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie");

    expect(setCookies).toHaveLength(3);

    for (const [index, header] of setCookies.entries()) {
      const n = index + 1;
      expect(header.value).toContain(`e2e-cookie-${n}=value-${n}`);
      // A folded header would carry all three pairs in one value. Each value
      // holding exactly one cookie is what proves they were not folded.
      expect(header.value).not.toContain("e2e-cookie-" + (n + 1));
    }
  });

  test("reads every cookie the client sent, not just the first", async ({
    request,
  }) => {
    // The inbound direction, and the reason it needs more than one cookie: the API
    // Gateway shell rebuilds a single `Cookie` header out of values that arrived
    // separately, joining them with `"; "`. A `","` join - correct for most
    // repeated headers - keeps only the *first* cookie readable. That is what broke
    // draft mode, and a single-cookie request would never have shown it.
    // `cdk-nextjs=1` is repeated here because a per-request `cookie` header is not
    // guaranteed to merge with the jar's (`storageState` in playwright.config.ts),
    // and the regional-containers example's ALB rejects a request without it.
    const response = await request.get("./api/echo?readcookies=1", {
      headers: {
        cookie: "cdk-nextjs=1; e2e-in-1=one; e2e-in-2=two; e2e-in-3=three",
      },
    });
    expect(response.status()).toBe(200);

    const { cookies: names } = await response.json();

    // All three, by name. Asserting a count would pass against a runtime that
    // parsed one cookie into three fragments, and asserting only the first would
    // pass against the comma-join bug itself.
    expect(names).toContain("e2e-in-1");
    expect(names).toContain("e2e-in-2");
    expect(names).toContain("e2e-in-3");
  });
});
