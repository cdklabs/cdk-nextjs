'use client';

import Button from '#/ui/button';
import { useFormState } from 'react-dom';
import { formAction } from './form-action';

export function Form() {
  const [state, formAction2] = useFormState(formAction, { message: '' });

  return (
    <form action={formAction2} className="flex flex-col gap-y-2">
      <label htmlFor="name-for-action-input">Name for Action Input</label>
      <input
        className="text-black"
        id="name-for-action-input"
        name="name"
        placeholder="Name for Action Input"
      />
      <div>
        <Button type="submit">Submit for Action Form</Button>
      </div>
      {state?.message && (
        <div className="mt-2 text-green-600">{state.message}</div>
      )}
    </form>
  );
}
