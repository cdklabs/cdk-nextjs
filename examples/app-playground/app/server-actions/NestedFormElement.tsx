import Button from '#/ui/button';
import { NameInput } from './components/NameInput';

export function NestedFormElement() {
  async function formAction(formData: FormData) {
    'use server';
    console.log('Nested Form Element Name: ', formData.get('name'));
  }
  return (
    <div className="flex flex-col gap-y-1">
      <h2>Nested Form Element</h2>
      <form className="flex flex-col gap-y-2">
        <NameInput />
        <div className="flex gap-x-1">
          <Button formAction={formAction} type="submit">
            Submit 1
          </Button>
          <Button formAction={formAction} type="submit">
            Submit 2
          </Button>
        </div>
      </form>
    </div>
  );
}
