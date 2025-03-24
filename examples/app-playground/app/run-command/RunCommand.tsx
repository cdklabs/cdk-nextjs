'use client';

import { useCallback, useState } from 'react';
import { submit } from './actions';

export function RunCommand() {
  const [command, setCommand] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const handleClick = useCallback(async () => {
    setLogs((oldLogs) => [`Command: ${command}`, ...oldLogs]);
    setCommand('');
    let output: string;
    try {
      output = await submit(command);
    } catch (err) {
      if (err instanceof Error) {
        output = err.toString();
      }
    }
    setLogs((oldLogs) => [`Output: ${output}`, ...oldLogs]);
  }, [command]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h1>Run Command</h1>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyUp={(e) => e.code === 'Enter' && handleClick()}
          style={{ backgroundColor: 'black', width: '50%', color: 'white' }}
        />
        <button onClick={handleClick} style={{ border: '2px solid white' }}>
          Execute Command
        </button>
      </div>
      <h2>Logs</h2>
      <ul>
        {logs.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
