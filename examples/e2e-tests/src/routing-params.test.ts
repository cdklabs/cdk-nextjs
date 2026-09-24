import { test, expect } from "@playwright/test";

/**
 * Dynamic route params, recovered from the deployed routing table.
 *
 * This is the layer with the least obvious failure mode in the whole runtime. A
 * deployment does not carry Next.js's route matcher around; params travel as
 * `nxtP`-prefixed query keys and the runtime has to recover them by name. Every bug
 * here produces a page that renders perfectly with a *wrong value* in it - no
 * error, no 404, nothing in a log.
 *
 * Each case below is a real defect with a jest regression test, proven so far on
 * `NextjsGlobalFunctions` only. These routes are the first time the other three
 * types are asked the same questions.
 */
test.describe("routing params", () => {
  test("gives each of two prefixing param names its own value", async ({
    page,
  }) => {
    // `id` is a prefix of `id2`. Recovering params by `startsWith` rather than by
    // equality gives `id2` the value of `id`, or drops it entirely. No committed
    // adapter fixture has a naturally prefixing pair, which is why
    // `dispatch.test.ts` has to rename one by hand - this route is the real thing.
    await page.goto("./params/prefix/first/second");

    const params = JSON.parse(
      (await page.getByTestId("params").textContent()) ?? "{}",
    );
    // Deliberately values that are not prefixes of each other, so the assertion
    // fails on a swap as well as on a drop.
    expect(params).toEqual({ id: "first", id2: "second" });
  });

  test("reports zero segments for an optional catch-all with none", async ({
    page,
  }) => {
    // The phantom-segment defect: matching the bare route handed the page one
    // segment whose value was the *string* `"undefined"`, because the recovered
    // params could not tell "absent" from "empty".
    await page.goto("./params/optional");

    await expect(page.getByTestId("segment-count")).toHaveText("0");

    // And the dump, because a count of zero is also what a correctly-absent param
    // and a `[""]` would both round to in some renderings.
    const raw = (await page.getByTestId("params").textContent()) ?? "";
    expect(raw).not.toContain("undefined");
  });

  test("reports both segments for an optional catch-all with two", async ({
    page,
  }) => {
    // The other side of the same route, so a fix that returns zero segments for
    // *everything* cannot pass the test above alone.
    await page.goto("./params/optional/alpha/beta");

    await expect(page.getByTestId("segment-count")).toHaveText("2");

    const params = JSON.parse(
      (await page.getByTestId("params").textContent()) ?? "{}",
    );
    expect(params).toEqual({ rest: ["alpha", "beta"] });
  });

  test("passes a percent-encoded path and query through exactly once", async ({
    page,
  }) => {
    // `%20` plus two-byte UTF-8 is what tells a double-decode from a double-encode.
    // The two deployment families disagree about what they are handed: a Lambda
    // Function URL gives the runtime a `rawPath` that is still encoded, while API
    // Gateway has already decoded both the path and the query, so the runtime
    // re-encodes the query before passing it on. Two code paths, one input.
    await page.goto(
      "./params/encoded/h%C3%A9llo%20w%C3%B6rld?q=h%C3%A9llo%20w%C3%B6rld",
    );

    const params = JSON.parse(
      (await page.getByTestId("params").textContent()) ?? "{}",
    );
    // App Router hands `params` over *still encoded* - verified against a dev
    // server, not assumed. So the assertion is that the value is byte-identical to
    // what was sent: a double-decode yields `héllo wörld` here and a double-encode
    // yields `h%25C3%25A9llo`.
    expect(params).toEqual({ slug: "h%C3%A9llo%20w%C3%B6rld" });

    const searchParams = JSON.parse(
      (await page.getByTestId("search-params").textContent()) ?? "{}",
    );
    // `searchParams`, by contrast, arrive decoded. Asserting both in one test is
    // the point: they are handled by different code on API Gateway, and a runtime
    // that decodes one layer too many or too few gets exactly one of these right.
    expect(searchParams).toEqual({ q: "héllo wörld" });
  });
});
