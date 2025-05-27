import { Suspense } from 'react';
import { LambdaSsmParameterValue } from './LambdaExtension';

export default function Page() {
  return (
    <div>
      <h1>AWS Lambda Parameters and Secrets Extension Example</h1>
      <p>
        /cdk-bootstrap/hnb659fds/version:{' '}
        <Suspense
          fallback={
            <span className="ml-2 inline-block h-4 w-24 animate-pulse rounded bg-gray-200"></span>
          }
        >
          <LambdaSsmParameterValue />
        </Suspense>
      </p>
    </div>
  );
}
