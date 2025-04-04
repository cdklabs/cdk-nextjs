import { EventHandlerForm } from './EventHandlerForm';
import { Form } from './Form';
import { FormWithAdditionalArgument } from './FormWithAdditionalArgument';
import { NestedFormElement } from './NestedFormElement';

export default function Page() {
  return (
    <div className="flex flex-col gap-y-3">
      <Form />
      <FormWithAdditionalArgument />
      <NestedFormElement />
      <EventHandlerForm />
    </div>
  );
}
