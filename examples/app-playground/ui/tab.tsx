'use client';

import type { Item } from '#/ui/tab-group';
import clsx from 'clsx';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { Suspense } from 'react';

export const Tab = ({
  path,
  parallelRoutesKey,
  item,
}: {
  path: string;
  parallelRoutesKey?: string;
  item: Item;
}) => {
  const href = item.slug ? path + '/' + item.slug : path;

  return (
    // `useSelectedLayoutSegment` reads the URL, so under `cacheComponents` it
    // suspends. Boundary as deep as possible: the prerendered shell still has
    // every tab, it just does not know yet which one is active.
    <Suspense fallback={<TabLink href={href} item={item} />}>
      <ActiveTabLink
        href={href}
        item={item}
        parallelRoutesKey={parallelRoutesKey}
      />
    </Suspense>
  );
};

function ActiveTabLink({
  href,
  item,
  parallelRoutesKey,
}: {
  href: string;
  item: Item;
  parallelRoutesKey?: string;
}) {
  const segment = useSelectedLayoutSegment(parallelRoutesKey);

  const isActive =
    // Example home pages e.g. `/layouts`
    (!item.slug && segment === null) ||
    segment === item.segment ||
    // Nested pages e.g. `/layouts/electronics`
    segment === item.slug;

  return <TabLink href={href} item={item} isActive={isActive} />;
}

function TabLink({
  href,
  item,
  isActive,
}: {
  href: string;
  item: Item;
  isActive?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={clsx('rounded-lg px-3 py-1 text-sm font-medium', {
        'bg-gray-700 text-gray-100 hover:bg-gray-500 hover:text-white':
          !isActive,
        'bg-vercel-blue text-white': isActive,
      })}
    >
      {item.text}
    </Link>
  );
}
