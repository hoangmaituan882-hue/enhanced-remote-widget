'use strict';

const path = require('path');
const { spawn } = require('child_process');

// Electron ignores every mouse button in native click-through mode. A scoped
// Windows helper captures only a right-button pair over this visible window.
module.exports = function createRightClickMonitor({ getWindow, onClick, onReady = () => {}, onError }, dependencies = {}) {
  const start = dependencies.spawn || spawn;
  const platform = dependencies.platform || process.platform;
  let session = null;
  let disposed = false;

  function stop() {
    const previous = session;
    session = null;
    if (!previous) return;
    clearTimeout(previous.startupTimer);
    // EOF asks the helper to unhook on its own message thread. Kill only our
    // child if that thread cannot exit; never leave an orphaned global hook.
    previous.child.stdin.end();
    previous.stopTimer = setTimeout(() => previous.child.kill(), 1000);
    previous.stopTimer.unref?.();
  }

  function sync(enabled) {
    if (!enabled || disposed) { stop(); return; }
    if (session) return;
    if (platform !== 'win32') {
      onError(new Error('Selective right-click recovery requires Windows.'));
      return;
    }
    let child;
    try {
      const handle = getWindow()?.getNativeWindowHandle();
      if (!handle || ![4, 8].includes(handle.length)) throw new Error('Native widget handle is unavailable.');
      const hexHandle = [...handle].reverse().map(byte => byte.toString(16).padStart(2, '0')).join('');
      child = start('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        path.join(__dirname, 'window-right-click.ps1'), '-WindowHandle', hexHandle], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      onError(error);
      return;
    }
    const current = { child, ready: false, pending: '', error: '', startupTimer: null, stopTimer: null };
    session = current;
    function fail(error) {
      if (disposed || session !== current) return;
      stop();
      onError(error);
    }
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { current.error = (current.error + text).slice(-2048); });
    child.stdout.on('data', text => {
      if (disposed || session !== current) return;
      current.pending += text;
      if (current.pending.length > 4096) { fail(new Error('Invalid right-click helper output.')); return; }
      let newline;
      while ((newline = current.pending.indexOf('\n')) !== -1) {
        const line = current.pending.slice(0, newline).trim();
        current.pending = current.pending.slice(newline + 1);
        if (line === 'READY' && !current.ready) {
          current.ready = true;
          clearTimeout(current.startupTimer);
          onReady();
        } else {
          const point = /^RIGHT_UP (-?\d+) (-?\d+)$/.exec(line);
          if (current.ready && point) {
            const x = Number(point[1]), y = Number(point[2]);
            if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) onClick({ x, y });
          }
        }
        if (session !== current) break;
      }
    });
    child.on('close', code => {
      clearTimeout(current.startupTimer);
      clearTimeout(current.stopTimer);
      if (disposed || session !== current) return;
      // The child has already exited; do not schedule another stop timeout.
      session = null;
      onError(new Error(current.error.trim() || `Right-click helper exited (${code}).`));
    });
    current.startupTimer = setTimeout(() => fail(new Error('Right-click helper did not become ready.')), 10000);
    current.startupTimer.unref?.();
  }

  return {
    sync,
    isReady: () => Boolean(session?.ready),
    dispose() { disposed = true; stop(); }
  };
};
