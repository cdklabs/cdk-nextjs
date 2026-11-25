# Contributing

Thanks for helping improve cdk-nextjs.

## Start with an issue

The most useful contribution is a clear [issue](https://github.com/cdklabs/cdk-nextjs/issues): what you deployed (construct, cdk-nextjs, Next.js and aws-cdk-lib versions), what you expected, what happened, and a reproduction or the logs and CloudFormation events that show it. If you know the fix, describe it in the issue, as a code snippet or a link to a commit on your fork.

## Pull requests from forks

Pull requests from forks are welcome as proposals, but they aren't merged as they are:

- The end-to-end tests deploy every example to an AWS account with OIDC credentials. Code from a fork never runs with those credentials, so the `e2e-tests` workflow skips pull requests from forks.
- To merge a change, a maintainer recreates it on a branch in this repository, where the end-to-end tests run, and closes the fork's pull request with a link to the new one. The merged commit credits you as a co-author.

Checks that need no credentials, such as the build and unit tests, still run on your pull request (on your first one, once a maintainer approves the run).

## Building locally

1. `git clone https://github.com/cdklabs/cdk-nextjs.git`
2. `cd cdk-nextjs`
3. `pnpm i && pnpm compile && pnpm build`

This project uses [Projen](https://projen.io/): don't edit the files it generates (they start with a header saying so). Edit `.projenrc.ts` instead, then run `pnpm projen`. See the [Development Guide](./docs/development-guide.md) for more.

## Reviewing your own branch

If you use [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), run `/self-review` on your branch before you ask for review. It reviews the branch in rounds, fixing and committing what holds up until a round comes back clean, then, on your own open pull request, pushes the fixes and posts its summary. It needs Node.js 24.2 or later and `gh` logged in to github.com. On a pull request from a fork it can't set its `self-review` commit status, which is expected. See [the skill](./.claude/skills/self-review/SKILL.md) for its options, such as `--no-publish`.

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:` and so on).
