'use client';

import { useState } from 'react';
import { eventHandlerAction } from './event-handler-action';
import { NameInput } from './components/NameInput';
import Button from '#/ui/button';

export function EventHandlerForm() {
  const [name, setName] = useState('');
  return (
    <div className="flex flex-col gap-y-1">
      <h2>Event Handler Form5</h2>
      <div className="flex flex-col gap-y-2">
        <NameInput value={name} onChange={(e) => setName(e.target.value)} />
        <div>
          <Button
            onClick={async (e) => {
              await eventHandlerAction(name);
            }}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
