'use server';

export async function formAction(prevState: unknown, formData: FormData) {
  console.log('Form Input:', formData.get('name'));
  return { message: 'Action Form Success' };
}
