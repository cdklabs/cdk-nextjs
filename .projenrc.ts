import { CdklabsConstructLibrary } from "cdklabs-projen-project-types";
const project = new CdklabsConstructLibrary({
  author: "AWS",
  authorAddress: "aws-cdk-dev@amazon.com",
  cdkVersion: "2.1.0",
  defaultReleaseBranch: "main",
  devDeps: ["cdklabs-projen-project-types"],
  name: "cdk-nextjs",
  projenrcTs: true,
  release: false,
  repositoryUrl: "https://github.com/cdklabs/cdk-nextjs.git",

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();