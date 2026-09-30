import type { GetServerSideProps } from "next";

interface Props {
  host: string;
}

export default function Ssr({ host }: Props) {
  return <main>served by {host}</main>;
}

/**
 * `maxDuration` is deliberate: cdk-nextjs does not honor per-route
 * `maxDuration`, and this fixture is what pins the warning it emits instead.
 */
export const config = { maxDuration: 30 };

export const getServerSideProps: GetServerSideProps<Props> = async ({
  req,
}) => ({
  props: { host: req.headers.host ?? "unknown" },
});
