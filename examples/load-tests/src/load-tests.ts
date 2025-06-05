import { Page } from "@playwright/test";
import { cpus } from "node:os";

const E2E_BASE_URL = process.env["E2E_BASE_URL"];
if (!E2E_BASE_URL) throw new Error("E2E_BASE_URL not set");
console.log("E2E_BASE_URL:", E2E_BASE_URL);
// artillery recommends 1 vCPU per concurrent virtual user
// https://www.artillery.io/docs/playwright
const MAX_ARRIVAL_RATE = cpus().length;
console.log("MAX_ARRIVAL_RATE:", MAX_ARRIVAL_RATE);

export const config = {
  target: E2E_BASE_URL,
  engines: {
    playwright: {},
  },
  phases: [
    // Warm-up phase - start with a low arrival rate
    {
      duration: "1min",
      arrivalRate: Math.round(MAX_ARRIVAL_RATE * 0.05),
      name: "Warm up",
    },
    // Ramp-up phase - gradually increase load
    {
      duration: "2min",
      arrivalRate: Math.round(MAX_ARRIVAL_RATE * 0.05),
      rampTo: Math.round(MAX_ARRIVAL_RATE * 0.5),
      name: "Ramp up load",
    },
    // Sustained load phase - maintain steady high load
    {
      duration: "5min",
      arrivalRate: Math.round(MAX_ARRIVAL_RATE * 0.5),
      name: "Sustained load",
    },
    // Spike phase - test sudden traffic spike
    {
      duration: "1min",
      arrivalRate: Math.round(MAX_ARRIVAL_RATE),
      name: "Spike test",
    },
    // Ramp-down phase - gradually decrease load
    {
      duration: "2min",
      arrivalRate: Math.round(MAX_ARRIVAL_RATE * 0.5),
      rampTo: Math.round(MAX_ARRIVAL_RATE * 0.05),
      name: "Ramp down",
    },
  ],
};

export const scenarios = [
  {
    engine: "playwright",
    name: "streaming",
    testFunction: testStreaming,
  },
  {
    engine: "playwright",
    name: "ssg",
    testFunction: testStaticData,
  },
  {
    engine: "playwright",
    name: "ssr",
    testFunction: testDynamicData,
  },
  {
    engine: "playwright",
    name: "isr",
    testFunction: testIsr,
  },
];

async function testStreaming(page: Page) {
  await page.goto("/streaming");
  await page.getByText("Edge Runtime").click();
  await page.getByRole("link", { name: "Node Runtime" }).click();
}

async function testStaticData(page: Page) {
  await page.goto("/ssg");
  await page.getByText("Post 1", { exact: true }).click();
  await page.getByText("Post 2", { exact: true }).click();
  // always visit post 3 instead of clicking on "Post ## (On Demand)" link
  // b/c artillery aggregates by url and having random post numbers adds noise
  await page.goto("/ssg/3");
}

async function testDynamicData(page: Page) {
  await page.goto("/ssr");
  await page.getByText("Post 1").click();
  await page.getByText("Post 2").click();
  await page.getByText("Post 3").click();
}

async function testIsr(page: Page) {
  await page.goto("/isr");
  await page.getByText("Post 1").click();
  await page.getByText("Post 2").click();
  await page.getByText("Post 3").click();
}
