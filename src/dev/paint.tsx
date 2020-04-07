import {EventEmitter} from 'events';
import React, {Component, useState} from 'react';
import {render, Color, Box} from 'ink';
import {useEventEmitter} from './use-event-emitter';
import ansiEscapes from 'ansi-escapes';
import chalk from 'chalk';
import indent from 'indent-string';

function BabelStatusOutput({babelErrors}: {babelErrors: Map<string, Error>}) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box>
        <Color bold underline>
          Details: Babel
        </Color>
      </Box>
      {Array.from(babelErrors.values()).map((err, i) => (
        <Box key={i} paddingTop={1}>
          {indent(err.toString(), 2)}
        </Box>
      ))}
    </Box>
  );
}

function TypeScriptWatchOutput({tscOutput}) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box>
        <Color bold underline>
          Details: TypeScript
        </Color>
      </Box>
      <Box>{tscOutput}</Box>
    </Box>
  );
}

function LogsOutput({title, logs}) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Color bold underline>
        {title}
      </Color>
      {logs.length === 0
        ? chalk.dim('  No output, yet.')
        : logs.map((msg, i) => <Box key={i}>{msg}</Box>)}
    </Box>
  );
}

function StatusLine({title, state}) {
  const dotLength = 16 - title.length;
  const dotStr = ''.padEnd(dotLength, '.');
  let stateStr = state;
  if (stateStr === 'READY' || stateStr === 'OK') {
    stateStr = chalk.green(state);
  } else if (stateStr === 'RUNNING') {
    stateStr = chalk.yellow(state);
  } else if (stateStr === 'ERROR') {
    stateStr = chalk.red(state);
  }
  return <Box>{`  ${title}${chalk.dim(dotStr)}[${stateStr}]`}</Box>;
}

function App({bus}) {
  const [tscOutput, setTscOutput] = useState('');
  const [tscErrors, setTscErrors] = useState(0);
  const [tscState, setTscState] = useState(null);
  const [babelErrors, setBabelErrors] = useState(new Map());
  const [serverLogs, setServerLogs] = useState([]);
  const [consoleLogs, setConsoleLogs] = useState([]);
  const hasTsc = !!tscState;

  useEventEmitter(bus, 'TSC_ERROR', ({num}) => {
    setTscErrors(num);
  });
  useEventEmitter(bus, 'TSC_RESET', () => {
    setTscState('IN_PROGRESS');
    setTscErrors(0);
    setTscOutput((prevValue) => (prevValue = ''));
  });
  useEventEmitter(bus, 'TSC_DONE', () => {
    setTscState('DONE');
  });
  useEventEmitter(bus, 'TSC_MSG', ({msg}) => {
    setTscOutput((prevValue) => (prevValue += indent(msg, 2) + '\n'));
  });
  useEventEmitter(bus, 'BABEL_ERROR', ({file, err}) => {
    setBabelErrors((prevValue) => {
      const newValue = new Map(prevValue);
      newValue.set(file, err);
      return newValue;
    });
  });
  useEventEmitter(bus, 'BABEL_FINISH', ({file}) => {
    setBabelErrors((prevValue) => {
      const newValue = new Map(prevValue);
      newValue.delete(file);
      return newValue;
    });
  });
  useEventEmitter(bus, 'CONSOLE', ({level, args}) => {
    setConsoleLogs((prevValue) => prevValue.concat(`  [${level}] ${args.join(' ')}`));
  });
  useEventEmitter(bus, 'SERVER_RESPONSE', ({method, url, statusCode, processingTime}) => {
    // const statusMsg = statusCode === 200 ? `${processingTime}ms` : statusCode;
    setConsoleLogs((prevValue) => prevValue.concat(`  [${statusCode}] ${method} ${url}`));
  });
  useEventEmitter(bus, 'NEW_SESSION', () => {
    setBabelErrors(new Map());
    setConsoleLogs([]);
    setServerLogs([]);
  });

  const showDetails = new Set();
  if (babelErrors && babelErrors.size > 0) {
    showDetails.add('BABEL');
  }
  if (hasTsc && tscErrors > 0) {
    showDetails.add('TYPESCRIPT');
  }

  return (
    <>
      <Box>
        {'🏔️  '}
        <Color cyan bold>
          snowpack dev
        </Color>
      </Box>
      {/* Status */}
      <Box flexDirection="column" paddingTop={1}>
        <Color bold underline>
          System Overview
        </Color>
        <StatusLine title="Server" state="READY" />
        <StatusLine title="Babel" state={babelErrors.size === 0 ? 'READY' : 'ERROR'} />
        {hasTsc && (
          <StatusLine
            title="TypeScript"
            state={tscErrors > 0 ? 'ERROR' : tscState === 'DONE' ? 'OK' : 'RUNNING'}
          />
        )}
      </Box>
      {/* Babel Output */}
      {showDetails.has('BABEL') && <BabelStatusOutput babelErrors={babelErrors} />}
      {/* Console Output */}
      {<LogsOutput title="Console" logs={consoleLogs} />}
      {/* Server Output */}
      {/* {!showDetails.has('TYPESCRIPT') && <LogsOutput title="Server Log" logs={serverLogs} />} */}
      {/* TypeScript Output */}
      {showDetails.has('TYPESCRIPT') && <TypeScriptWatchOutput tscOutput={tscOutput} />}
    </>
  );
}

export function paint(bus: EventEmitter) {
  process.stdout.write(ansiEscapes.clearTerminal);
  render(<App bus={bus} />);
}
