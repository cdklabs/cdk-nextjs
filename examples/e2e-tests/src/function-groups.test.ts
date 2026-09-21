import { test, expect } from "@playwright/test";

/**
 * `functionGroups` splits one Next.js app across several Lambda functions to
 * stay under Lambda's 250 MB unzipped limit. Only meaningful on a deployment
 * that declared groups, so the example that does sets `E2E_FUNCTION_GROUPS` to
 * the group name owning `/api/**` (see `examples/global-functions/app.ts`).
 *
 * What can silently break: the edge routes by path pattern while the build
 * packages by route, and the two decisions are made in different processes. A
 * mismatch means CloudFront sending `/api/*` to a function whose zip has no
 * `/api` entrypoint - a 500 at request time, invisible at synth.
 */
const groupName = process.env["E2E_FUNCTION_GROUPS"];

test.describe("function groups", () => {
  test.skip(
    !groupName,
    "deployment did not declare functionGroups; set E2E_FUNCTION_GROUPS to the group owning /api/**",
  );

  test("serves a grouped route and an ungrouped one from different functions", async ({
    request,
  }) => {
    const [grouped, ungrouped] = await Promise.all([
      request.get("./api/runtime-identity"),
      request.get("./runtime-identity"),
    ]);
    expect(grouped.status()).toBe(200);
    expect(ungrouped.status()).toBe(200);

    const groupedBody = await grouped.json();
    const ungroupedBody = await ungrouped.json();

    // The route under /api/** is packaged into, and routed to, the declared
    // group. Everything else stays in "default".
    expect(groupedBody.functionGroup).toBe(groupName);
    expect(ungroupedBody.functionGroup).toBe("default");

    // Same app, genuinely different Lambda functions - not one function
    // reporting two names.
    expect(groupedBody.computeId).toBeTruthy();
    expect(ungroupedBody.computeId).toBeTruthy();
    expect(groupedBody.computeId).not.toBe(ungroupedBody.computeId);
  });

  test("keeps the routes a group does not own on the default function", async ({
    request,
  }) => {
    // `/api/**` is a subtree: it owns what is *under* `/api`, and the pages
    // above it are untouched. A group that accidentally swallowed `/` would
    // still pass the test above.
    const home = await request.get("./");
    expect(home.status()).toBe(200);
    expect(await home.text()).toContain("<!DOCTYPE html>");
  });

  test("still serves an API route inside the group", async ({ request }) => {
    const health = await request.get("./api/health");
    expect(health.status()).toBe(200);
  });
});
