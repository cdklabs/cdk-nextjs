import Button from '#/ui/button';

export function FormWithAdditionalArgument() {
  async function formAction(id: number, formData: FormData) {
    'use server';
    console.log('Form With Additional Arugment ID:', id);
    console.log('Form With Additional Arugment Name:', formData.get('name'));
  }
  const id = 1;
  return (
    <form action={formAction.bind(null, id)} className="flex flex-col gap-y-2">
      <label htmlFor="name-for-additional-arguments-form">
        Name for Additional Arguments Form
      </label>
      <input
        className="text-black"
        id="name-for-additional-arguments-form"
        name="name"
        placeholder="Name for Additional Arguments Form"
      ></input>
      <div>
        <Button type="submit">Submit for Additional Arguments Form</Button>
      </div>
    </form>
  );
}
