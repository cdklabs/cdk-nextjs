import Button from '#/ui/button';
import { NameInput } from './components/NameInput';

export function FormWithAdditionalArgument() {
  async function formAction(id: number, formData: FormData) {
    'use server';
    console.log('Form With Additional Arugment ID:', id);
    console.log('Form With Additional Arugment Name:', formData.get('name'));
  }
  const id = 1;
  return (
    <div className="flex flex-col gap-y-1">
      <h2>Form with Additional Argument</h2>
      <form
        action={formAction.bind(null, id)}
        className="flex flex-col gap-y-2"
      >
        <NameInput />
        <div>
          <Button type="submit">Submit</Button>
        </div>
      </form>
    </div>
  );
}
