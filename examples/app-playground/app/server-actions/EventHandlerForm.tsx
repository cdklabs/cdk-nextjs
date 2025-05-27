'use client';

import { startTransition, useState } from 'react';
import { eventHandlerAction } from './event-handler-action';
import Button from '#/ui/button';

export function EventHandlerForm() {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  return (
    <div className="flex flex-col gap-y-2">
      <label htmlFor="name-for-event-handler-input">
        Name for Event Handler Input
      </label>
      <input
        className="text-black"
        id="name-for-event-handler-input"
        name="name"
        onChange={(e) => setName(e.target.value)}
        placeholder="Name for Event Handler Input"
      />
      <div>
        <Button
          onClick={async (e) => {
            startTransition(async () => {
              const res = await eventHandlerAction(name);
              setMessage(res.message);
            });
          }}
        >
          Submit for Event Handler Form
        </Button>
      </div>
      {message && <div className="mt-2 text-green-600">{message}</div>}
    </div>
  );
}
