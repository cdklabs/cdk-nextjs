import type { GetStaticPaths, GetStaticProps } from "next";

interface Props {
  slug: string;
  locale: string;
  renderedAt: string;
}

export default function Post({ slug, locale, renderedAt }: Props) {
  return (
    <main>
      <h1>
        {slug} ({locale})
      </h1>
      <p>{renderedAt}</p>
    </main>
  );
}

/** One prerendered path, so the build emits both a prerender and a fallback. */
export const getStaticPaths: GetStaticPaths = () => ({
  paths: [{ params: { slug: "hello" }, locale: "en-US" }],
  fallback: "blocking",
});

/** `revalidate` makes this an ISR route, i.e. a prerender the runtime revalidates. */
export const getStaticProps: GetStaticProps<Props> = ({ params, locale }) => ({
  props: {
    slug: String(params?.["slug"]),
    locale: locale ?? "en-US",
    renderedAt: new Date().toISOString(),
  },
  revalidate: 60,
});
