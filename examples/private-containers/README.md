# Private Containers Example

## Steps

1. Install AWS CLI and [Session Manager Plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
1. `pnpm run deploy`
1. See terminal output and look for `dev-prvt-cntnrs.CdkNextjsUrl`. Add to .env as `PRIVATE_HOST=""`. Make sure not to include "http://".
1. See terminal output and look for `dev-prvt-cntnrs.BastionId`. Add to .env as `BASTION_ID=""`
1. `pnpm connect`
1. Visit private app at http://localhost:3000
