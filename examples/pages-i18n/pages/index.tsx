import Link from "next/link";
import { useRouter } from "next/router";

export default function Home() {
  const { locale, locales, defaultLocale } = useRouter();
  return (
    <main>
      <h1>pages-i18n</h1>
      <p>
        locale {locale} of {locales?.join(", ")} (default {defaultLocale})
      </p>
      <Link href="/blog/hello">/blog/hello</Link>
      <Link href="/ssr">/ssr</Link>
    </main>
  );
}
