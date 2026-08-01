#!/usr/bin/env node
/**
 * Pre-flight for `npm run dev`: refuse to start if either dev port is taken.
 *
 * Runs as npm's `predev` hook, so a clash is reported ONCE, clearly, before
 * anything starts — instead of the state this replaces, where the server threw a
 * raw EADDRINUSE stack trace on repeat under `ts-node-dev --respawn` while the
 * client quietly moved to 5174 and left the app half-running against a port
 * nothing was serving.
 *
 * Ports come from the same places the apps read them, so this cannot drift:
 * PORT for the server and VITE_PORT for the client.
 */

const net = require('net');
const { execSync } = require('child_process');

const SERVER_PORT = Number(process.env.PORT || 3010);
const CLIENT_PORT = Number(process.env.VITE_PORT || 5173);

/**
 * Is something already listening on this port?
 *
 * Binds 0.0.0.0 rather than 127.0.0.1 on purpose: the dev servers bind all
 * interfaces, and a loopback-only probe would miss a listener that will still
 * collide with them.
 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (error) => resolve(error.code === 'EADDRINUSE'))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '0.0.0.0');
  });
}

/**
 * Best-effort PID of whatever holds the port, so the message names the culprit
 * instead of leaving the reader to look it up. Returns null when it cannot tell —
 * the advice below still stands without it.
 */
function findHolder(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = new Set(
        out
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && /^\d+$/.test(pid))
      );
      return pids.size > 0 ? [...pids].join(', ') : null;
    }
    const out = execSync(`lsof -ti tcp:${port}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out.split(/\s+/).filter(Boolean);
    return pids.length > 0 ? pids.join(', ') : null;
  } catch {
    return null;
  }
}

/** How to stop the offending process on this platform. */
function killAdvice(port, pid) {
  if (process.platform === 'win32') {
    return pid
      ? `taskkill /PID ${pid.split(', ')[0]} /F`
      : `netstat -ano | findstr :${port}   then   taskkill /PID <pid> /F`;
  }
  return pid ? `kill ${pid.split(', ')[0]}` : `lsof -ti tcp:${port} | xargs kill`;
}

async function main() {
  const checks = [
    { name: 'server', port: SERVER_PORT, envVar: 'PORT' },
    { name: 'client', port: CLIENT_PORT, envVar: 'VITE_PORT' },
  ];

  const busy = [];
  for (const check of checks) {
    if (await isPortBusy(check.port)) {
      busy.push({ ...check, pid: findHolder(check.port) });
    }
  }

  if (busy.length === 0) {
    return;
  }

  const lines = ['', 'Cannot start: a dev port is already in use.', ''];
  for (const entry of busy) {
    lines.push(
      `  ${entry.name} port ${entry.port} is taken${entry.pid ? ` by PID ${entry.pid}` : ''}`,
      `    stop it:  ${killAdvice(entry.port, entry.pid)}`,
      `    or move:  ${entry.envVar}=${entry.port + 1} npm run dev`
    );
  }
  lines.push(
    '',
    '  This is nearly always a dev server from an earlier session that was never stopped.',
    '  Both ports are checked together so you fix them in one pass rather than',
    '  discovering the second one after restarting.',
    ''
  );

  if (busy.some((entry) => entry.name === 'client')) {
    lines.push(
      '  Note: moving the client port also changes the UI base URL that',
      '  tests/config/test-config.json and the API CORS allow-list expect, so prefer',
      '  freeing 5173 over relocating it.',
      ''
    );
  }
  if (busy.some((entry) => entry.name === 'server')) {
    lines.push(
      '  Note: moving the server port needs the client proxy moved with it:',
      `    PORT=<new> VITE_API_TARGET=http://localhost:<new> npm run dev`,
      ''
    );
  }

  console.error(lines.join('\n'));
  process.exit(1);
}

main().catch((error) => {
  // A failure to CHECK must not block a developer from starting the app.
  console.error('[check-ports] could not verify ports:', error.message);
});
