'use client';

import { useState } from 'react';

/** Something to click, so the browser load tests can measure INP. */
export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button data-bench-counter onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  );
}
