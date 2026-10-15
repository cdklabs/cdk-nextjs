import { Token } from "aws-cdk-lib";
import {
  assertBehaviorBudget,
  BehaviorBudgetProps,
  DEFAULT_MAX_CACHE_BEHAVIORS,
} from "./behavior-budget";

describe("assertBehaviorBudget", () => {
  const props = (
    overrides: Partial<BehaviorBudgetProps> = {},
  ): BehaviorBudgetProps => ({
    limit: DEFAULT_MAX_CACHE_BEHAVIORS,
    basePath: "",
    assetPrefix: "",
    publicPatterns: 0,
    groupPatterns: 0,
    ...overrides,
  });

  it("allows exactly the limit", () => {
    // 3 fixed + 72 public = 75
    expect(() =>
      assertBehaviorBudget(props({ publicPatterns: 72 })),
    ).not.toThrow();
    expect(() => assertBehaviorBudget(props({ publicPatterns: 73 }))).toThrow(
      "needs 76 CloudFront cache behaviors, over the limit of 75",
    );
  });

  it("counts one for the service worker behavior", () => {
    expect(() =>
      assertBehaviorBudget(props({ limit: 4, serviceWorker: true })),
    ).not.toThrow();
    expect(() =>
      assertBehaviorBudget(
        props({ limit: 4, serviceWorker: true, publicPatterns: 1 }),
      ),
    ).toThrow("needs 5 CloudFront cache behaviors, over the limit of 4");
  });

  it("counts two for a basePath and one for an assetPrefix", () => {
    expect(() =>
      assertBehaviorBudget(
        props({ limit: 6, basePath: "base", assetPrefix: "/cdn" }),
      ),
    ).not.toThrow();
    expect(() =>
      assertBehaviorBudget(
        props({
          limit: 6,
          basePath: "base",
          assetPrefix: "/cdn",
          publicPatterns: 1,
        }),
      ),
    ).toThrow(
      "needs 7 CloudFront cache behaviors, over the limit of 6 per " +
        "distribution: 6 used by cdk-nextjs itself, 1 for top-level public/ " +
        "entries. Move public/ files into a single top-level directory " +
        "(one behavior serves `static/*`). If",
    );
  });

  it("names function groups only when there are some", () => {
    expect(() =>
      assertBehaviorBudget(
        props({ limit: 5, publicPatterns: 1, groupPatterns: 2 }),
      ),
    ).toThrow(
      "3 used by cdk-nextjs itself, 1 for top-level public/ entries, 2 for " +
        "`functionGroups` patterns. Move public/ files into a single " +
        "top-level directory (one behavior serves `static/*`), and prefer " +
        "one subtree pattern per function group over several exact paths.",
    );
  });

  it("skips the check when the limit is a token", () => {
    const limit = Token.asNumber({ resolve: () => 1 });
    expect(() =>
      assertBehaviorBudget(props({ limit, publicPatterns: 100 })),
    ).not.toThrow();
  });
});
