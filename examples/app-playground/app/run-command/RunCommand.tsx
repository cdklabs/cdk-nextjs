'use client';

import { useCallback, useState } from 'react';
import { submit } from './actions';

export function RunCommand() {
  const [command, setCommand] = useState('');
  const [logs, setLogs] = useState<Array<{ command: string; output: string }>>(
    [],
  );
  const [historyIndex, setHistoryIndex] = useState(-1);

  const handleClick = useCallback(async () => {
    const currentCommand = command;
    setCommand('');
    let output: string;
    try {
      output = await submit(currentCommand);
    } catch (err) {
      output = err instanceof Error ? err.toString() : 'Unknown error';
    }
    setLogs((oldLogs) => [{ command: currentCommand, output }, ...oldLogs]);
  }, [command]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h1>Run Command</h1>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyUp={(e) => {
            if (e.code === 'Enter') {
              handleClick();
              setHistoryIndex(-1);
            } else if (e.code === 'ArrowUp' && logs.length > 0) {
              const newIndex = historyIndex + 1;
              if (newIndex < logs.length) {
                setHistoryIndex(newIndex);
                setCommand(logs[newIndex].command);
              }
            } else if (e.code === 'ArrowDown' && historyIndex >= 0) {
              const newIndex = historyIndex - 1;
              setHistoryIndex(newIndex);
              setCommand(newIndex >= 0 ? logs[newIndex].command : '');
            }
          }}
          style={{
            backgroundColor: 'black',
            width: '80%',
            color: 'white',
            padding: '0.5rem',
            fontFamily: 'monospace',
          }}
        />
        <button onClick={handleClick} style={{ border: '2px solid white' }}>
          Execute Command
        </button>
      </div>
      <h2>Logs</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        {logs.map((log, index) => (
          <div
            key={index}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
          >
            <div style={{ fontFamily: 'monospace' }}>$ {log.command}</div>
            <div
              style={{
                marginLeft: '1rem',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
              }}
            >
              {log.output}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
