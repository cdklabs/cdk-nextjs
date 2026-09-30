import Link from 'next/link';

export const metadata = { title: 'cdk-nextjs bench app' };

const routes = ['static', 'ssr', 'isr', 'stream', 'image'];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>
        <nav style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <Link href="/">home</Link>
          {routes.map((route) => (
            <Link key={route} href={`/${route}`} data-bench-link={route}>
              {route}
            </Link>
          ))}
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
