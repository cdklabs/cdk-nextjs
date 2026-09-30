import Image from 'next/image';
import { Counter } from '#/lib/counter';

export default function Page() {
  return (
    <>
      <h1 data-bench="image">Image</h1>
      <Counter />
      <Image src="/bench.jpg" alt="bench" width={640} height={640} priority />
    </>
  );
}
