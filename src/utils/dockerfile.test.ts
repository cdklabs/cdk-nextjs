import {
  dockerfileAction,
  GENERATED_DOCKERFILE_HEADER,
  isGeneratedDockerfileContent,
} from "./dockerfile";

const GENERATED = `${GENERATED_DOCKERFILE_HEADER}\nFROM node:24\nCMD ["node", "server.mjs"]\n`;

describe("isGeneratedDockerfileContent", () => {
  it("is true when the first line starts with the header", () => {
    expect(isGeneratedDockerfileContent(GENERATED)).toBe(true);
    expect(isGeneratedDockerfileContent(GENERATED_DOCKERFILE_HEADER)).toBe(
      true,
    );
    expect(
      isGeneratedDockerfileContent(
        `${GENERATED_DOCKERFILE_HEADER} v0.5\nFROM x`,
      ),
    ).toBe(true);
  });

  it("is false when the header is missing or not on the first line", () => {
    expect(isGeneratedDockerfileContent("FROM node:24\n")).toBe(false);
    expect(isGeneratedDockerfileContent("")).toBe(false);
    expect(
      isGeneratedDockerfileContent(`\n${GENERATED_DOCKERFILE_HEADER}\nFROM x`),
    ).toBe(false);
    expect(
      isGeneratedDockerfileContent(` ${GENERATED_DOCKERFILE_HEADER}\nFROM x`),
    ).toBe(false);
  });
});

describe("dockerfileAction", () => {
  it("creates the generated Dockerfile when there is none", () => {
    expect(dockerfileAction(undefined, () => GENERATED)).toEqual({
      kind: "create",
      content: GENERATED,
    });
  });

  it("keeps a Dockerfile the developer wrote, without reading the generated one", () => {
    const generated = jest.fn(() => GENERATED);
    expect(dockerfileAction("FROM node:24\n", generated)).toEqual({
      kind: "keep",
    });
    // An empty file has no header either, so it is the developer's too.
    expect(dockerfileAction("", generated)).toEqual({ kind: "keep" });
    expect(generated).not.toHaveBeenCalled();
  });

  it("leaves this version's generated Dockerfile unchanged", () => {
    expect(dockerfileAction(GENERATED, () => GENERATED)).toEqual({
      kind: "unchanged",
    });
  });

  it("replaces a generated Dockerfile that differs, edited or older", () => {
    const stale = `${GENERATED_DOCKERFILE_HEADER}\nFROM node:20\nCMD ["node", "server.js"]\n`;
    expect(dockerfileAction(stale, () => GENERATED)).toEqual({
      kind: "replace",
      content: GENERATED,
    });
  });

  it("propagates a failure to read the generated Dockerfile", () => {
    const missing = () => {
      throw new Error("Source Dockerfile not found");
    };
    expect(() => dockerfileAction(undefined, missing)).toThrow(
      "Source Dockerfile not found",
    );
    expect(() => dockerfileAction(GENERATED, missing)).toThrow(
      "Source Dockerfile not found",
    );
  });
});
