import { check } from "k6";
import { browser, Page } from "k6/browser";
import { Trend } from "k6/metrics";
import { BASE_URL, COOKIE } from "./config.ts";

/** Pages the browser visits, each a link in the bench app's nav. */
export const BROWSER_ROUTES = ["static", "ssr", "isr", "stream", "image"] as const;

// INP is left out: k6 only reports it for some pages, and it measures the
// client, not the construct.
const VITALS = ["lcp", "fcp", "cls", "ttfb"];

/**
 * Click on a nav link until the new page's heading is in the DOM: a client-side
 * navigation. Timed in the page, since timing it from k6 adds a constant
 * ~200 ms of browser-protocol round trips.
 */
const navDuration = new Trend("browser_nav_duration", true);

export const BROWSER_OPTIONS = { browser: { type: "chromium" } } as const;

/** Makes k6 report every Web Vital and navigation time per route. */
export function browserThresholds(): Record<string, string[]> {
  const thresholds: Record<string, string[]> = {};
  for (const route of ["home", ...BROWSER_ROUTES]) {
    for (const vital of VITALS) thresholds[`browser_web_vital_${vital}{name:${route}}`] = ["max>=0"];
  }
  for (const route of BROWSER_ROUTES) thresholds[`browser_nav_duration{route:${route}}`] = ["max>=0"];
  return thresholds;
}

/**
 * One visitor: a full page load of every route (Web Vitals), then client-side
 * navigation between them through the nav links (the RSC path).
 */
export async function browserFlow(): Promise<void> {
  const context = await browser.newContext();
  if (COOKIE) {
    const [name, ...value] = COOKIE.split("=");
    await context.addCookies([{ name: name!, value: value.join("="), url: BASE_URL }]);
  }
  const page = await context.newPage();
  page.on("metric", (metric) => {
    metric.tag({
      name: "home",
      matches: [{ url: new RegExp(`^${escape(BASE_URL)}/?$`) }],
    });
    for (const route of BROWSER_ROUTES) {
      metric.tag({ name: route, matches: [{ url: new RegExp(`/${route}(\\?.*)?$`) }] });
    }
  });
  try {
    for (const route of BROWSER_ROUTES) {
      await page.goto(`${BASE_URL}/${route}`, { waitUntil: "load" });
      await heading(page, route);
      // LCP is final at the first input. Without one it is reported on unload,
      // tagged with whatever URL the page has by then.
      await page.locator("[data-bench-counter]").click();
    }
    await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
    await heading(page, "home");
    await page.locator("[data-bench-counter]").click();
    for (const route of BROWSER_ROUTES) {
      navDuration.add(await clientNavigation(page, route), { route });
      await heading(page, route);
    }
  } finally {
    await page.close();
    await context.close();
  }
}

async function heading(page: Page, route: string): Promise<void> {
  const locator = page.locator(`[data-bench="${route}"]`);
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  check(page, { [`${route} rendered`]: () => true });
}

async function clientNavigation(page: Page, route: string): Promise<number> {
  // k6's types don't unwrap a page function's Promise, but evaluate() awaits it
  const ms: unknown = await page.evaluate(
    (route: string) =>
      new Promise<number>((resolve, reject) => {
        const selector = `[data-bench="${route}"]`;
        const start = performance.now();
        const timeout = setTimeout(() => reject(new Error(`${route} never rendered`)), 30_000);
        const observer = new MutationObserver(() => {
          if (!document.querySelector(selector)) return;
          observer.disconnect();
          clearTimeout(timeout);
          resolve(performance.now() - start);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.querySelector<HTMLElement>(`[data-bench-link="${route}"]`)!.click();
      }),
    route,
  );
  return ms as number;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
