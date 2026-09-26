import { Counter } from '#/lib/counter';

export default function Page() {
  return (
    <>
      <h1 data-bench="home">Home</h1>
      <Counter />
    </>
  );
}
