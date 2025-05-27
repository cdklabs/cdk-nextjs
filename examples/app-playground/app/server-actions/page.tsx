import { EventHandlerForm } from './EventHandlerForm';
import { Form } from './Form';
import { FormWithAdditionalArgument } from './FormWithAdditionalArgument';

export default function Page() {
  return (
    <div className="flex flex-col gap-y-3">
      <h1>Server Actions</h1>
      <Form />
      <EventHandlerForm />
      {/* no e2e tests for below components but still helpful to test manually */}
      <FormWithAdditionalArgument />
    </div>
  );
}
