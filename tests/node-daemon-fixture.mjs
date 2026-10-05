import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export function startDaemon(directory, respond, script = 'node-daemon.mjs', action) {
  const child = fork(join(directory, 'release/scripts', script), ['--installation', directory, ...(action ? ['--action', action] : [])], {
    execArgv: ['--import', fileURLToPath(new URL('./cloud/installed-fetch-fixture.mjs', import.meta.url))], silent: true,
  });
  const updates = new EventEmitter(), state = { child, events: [], requests: [], stdout: '', stderr: '', closed: false, code: null, fault: null };
  let buffered = '';
  child.stdout.on('data', data => {
    state.stdout += data; buffered += data;
    for (;;) { const end = buffered.indexOf('\n'); if (end < 0) break; const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); try { state.events.push(JSON.parse(line)); } catch (error) { state.fault = error; } }
    updates.emit('update');
  });
  child.stderr.on('data', data => { state.stderr += data; });
  child.on('error', error => { state.fault = error; updates.emit('update'); });
  child.on('close', code => { state.closed = true; state.code = code; updates.emit('update'); });
  child.on('message', async request => {
    state.requests.push({ ...request, receivedAt: Date.now() }); updates.emit('update');
    try {
      const response = await respond(request, state);
      if (child.connected) child.send({ id: request.id, ...response });
    } catch (error) { state.fault = error; if (child.connected) child.send({ id: request.id, error: true }); updates.emit('update'); }
  });
  state.until = predicate => new Promise((resolve, reject) => {
    function check() {
      if (state.fault) done(state.fault);
      else if (predicate(state)) done();
      else if (state.closed) done(new Error(`daemon closed unexpectedly (${state.code}): ${state.stderr}`));
    }
    function done(error) { clearTimeout(timer); updates.off('update', check); error ? reject(error) : resolve(state); }
    const timer = setTimeout(() => done(new Error('daemon fixture timeout')), 65000);
    updates.on('update', check); check();
  });
  state.stop = async (signal = 'SIGTERM', code = 0) => { if (!state.closed) child.kill(signal); await state.until(s => s.closed); assert.equal(state.code, code, state.stderr); };
  state.dispose = async () => { if (!state.closed) { child.kill('SIGKILL'); await state.until(s => s.closed); } };
  return state;
}
export const responseJson = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
