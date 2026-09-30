import { test, expect, APIRequestContext } from "@playwright/test";
import { isContainers, isLocal } from "./utils/deployment-type";
import { waitXSec } from "./utils/wait-5-sec";

/**
 * `'use cache'` and `'use cache: remote'` across compute instances, through the
 * `/api/use-cache/*` routes in `examples/app-playground/app/api/use-cache`.
 *
 * - `remote` is stored in S3 by cdk-nextjs's `cacheHandlers.remote`, so every
 *   instance answers with the same value.
 * - `default` stays in each instance's memory, so values differ per instance,
 *   but a `revalidateTag` on one instance has to expire the entry on all of them
 *   (`cacheHandlers.default` reads the revalidation table's tag markers).
 *
 * Needs more than one instance to prove anything. Concurrent requests that
 * overlap (each is held for {@link HOLD_MS}) make Lambda start one per request;
 * the container types run a single Fargate task by default, so there the
 * cross-instance assertions skip.
 */

/** How long each request in a burst is held, so the burst overlaps. */
const HOLD_MS = 1000;
const BURST = 8;
const MAX_ROUNDS = 6;

/**
 * Longer than the tag markers' refresh interval
 * (`CDK_NEXTJS_TAG_REFRESH_MS`, 1s by default), so every instance has
 * re-read them by the time a request is sent.
 */
const TAG_REFRESH_WAIT_SEC = 3;

interface Sample {
  value: string;
  generatedAt: number;
  instanceId: string;
}

type Kind = "remote" | "default";

/** A key no earlier run, and no test running alongside, has cached. */
function uniqueKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function sample(
  request: APIRequestContext,
  kind: Kind,
  key: string,
  holdMs = 0,
): Promise<Sample> {
  const response = await request.get(
    `./api/use-cache/${kind}?key=${key}&holdMs=${holdMs}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Sample;
}

async function burst(
  request: APIRequestContext,
  kind: Kind,
  key: string,
): Promise<Sample[]> {
  return Promise.all(
    Array.from({ length: BURST }, () => sample(request, kind, key, HOLD_MS)),
  );
}

async function revalidate(request: APIRequestContext, key: string) {
  const response = await request.get(`./api/use-cache/revalidate?key=${key}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ revalidated: true });
}

/** Skips when a single instance served everything and that is expected. */
function requireInstances(instances: number, what: string) {
  test.skip(
    instances < 2 && isContainers(),
    `only one instance answered (${what}); the container types run one task by default`,
  );
  expect(
    instances,
    `distinct instances that answered (${what})`,
  ).toBeGreaterThanOrEqual(2);
}

test.describe("use cache", () => {
  test.skip(isLocal(), "no shared cache or multiple instances locally");

  test("'use cache: remote' is shared across instances and revalidated on all of them", async ({
    request,
  }) => {
    const key = uniqueKey();

    // One request generates and stores the entry, so the bursts below read it
    // rather than racing to generate their own.
    const first = await sample(request, "remote", key);
    await waitXSec(2);

    const instances = new Set<string>();
    for (let round = 0; round < MAX_ROUNDS && instances.size < 2; round++) {
      for (const s of await burst(request, "remote", key)) {
        expect(s.value, `instance ${s.instanceId}`).toBe(first.value);
        instances.add(s.instanceId);
      }
    }
    requireInstances(instances.size, "before revalidation");

    await revalidate(request, key);
    await waitXSec(TAG_REFRESH_WAIT_SEC);

    const regenerated = await sample(request, "remote", key);
    expect(regenerated.value).not.toBe(first.value);
    await waitXSec(2);

    const after = new Set<string>();
    for (let round = 0; round < MAX_ROUNDS && after.size < 2; round++) {
      for (const s of await burst(request, "remote", key)) {
        // No instance may still answer from its memory copy of the old entry.
        expect(s.value, `instance ${s.instanceId}`).toBe(regenerated.value);
        after.add(s.instanceId);
      }
    }
    requireInstances(after.size, "after revalidation");
  });

  test("plain 'use cache' honors revalidateTag on every instance", async ({
    request,
  }) => {
    const key = uniqueKey();

    // Each instance generates, and then keeps, its own value.
    const before = new Map<string, string>();
    for (let round = 0; round < MAX_ROUNDS && before.size < 2; round++) {
      for (const s of await burst(request, "default", key)) {
        const known = before.get(s.instanceId);
        if (known !== undefined) {
          expect(s.value, `instance ${s.instanceId} is cached`).toBe(known);
        } else {
          before.set(s.instanceId, s.value);
        }
      }
    }
    requireInstances(before.size, "before revalidation");
    const oldValues = new Set(before.values());

    // Reaches one instance. Every other one only learns of it from the table.
    await revalidate(request, key);
    await waitXSec(TAG_REFRESH_WAIT_SEC);

    const revisited = new Set<string>();
    for (let round = 0; round < MAX_ROUNDS && revisited.size < 2; round++) {
      for (const s of await burst(request, "default", key)) {
        expect(
          oldValues.has(s.value),
          `instance ${s.instanceId} served its pre-revalidation value`,
        ).toBe(false);
        if (before.has(s.instanceId)) {
          revisited.add(s.instanceId);
        }
      }
    }
    // Instances that held the old entry, not just fresh ones that never had it.
    requireInstances(revisited.size, "that held the old entry");
  });
});
