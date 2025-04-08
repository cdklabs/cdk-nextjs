import Button from '#/ui/button';
import { NameInput } from './components/NameInput';

export function Form() {
  async function formAction(formData: FormData) {
    'use server';
    console.log('Form Input:', formData.get('name'));
  }
  return (
    <div className="flex flex-col gap-y-1">
      <h2>Form</h2>
      <form action={formAction} className="flex flex-col gap-y-2">
        <NameInput />
        <div>
          <Button type="submit">Submit</Button>
        </div>
      </form>
    </div>
  );
}
