'use server';
export async function eventHandlerAction(name: string) {
  console.log('Event Handler Action Input:', name);
  return { message: 'Event Handler Form Success' };
}
