'use strict';

const path = require('path');
const actionIds = new Set(['menu-play', 'menu-prev', 'menu-next', 'menu-like', 'menu-settings',
  'menu-layout', 'menu-palette', 'menu-disable-click-through', 'menu-zen', 'menu-edge-dock',
  'menu-lock', 'menu-pin', 'menu-close']);

// The popup owns only its own bounds. Opening a menu must never resize or move
// the player, nor write any player layout profile.
module.exports = function createMenuWindow({ BrowserWindow, screen, getOwner, webPreferences,
  restrictNavigation, onOpenChange, onSelect, onError }) {
  let window = null;
  let loaded = false;
  let active = null;
  let sequence = 0;
  let startupTimer = null;
  let disposed = false;

  function fit(point, size) {
    const area = screen.getDisplayNearestPoint(point).workArea;
    const margin = Math.min(4, Math.max(0, Math.floor(Math.min(area.width, area.height) / 4)));
    const width = Math.max(1, Math.min(Math.ceil(size.width), area.width - margin * 2));
    const height = Math.max(1, Math.min(Math.ceil(size.height), area.height - margin * 2));
    const right = area.x + area.width - margin;
    const bottom = area.y + area.height - margin;
    let x = point.x + 2, y = point.y + 2;
    if (x + width > right) x = point.x - width - 2;
    if (y + height > bottom) y = point.y - height - 2;
    return { x: Math.round(Math.max(area.x + margin, Math.min(x, right - width))),
      y: Math.round(Math.max(area.y + margin, Math.min(y, bottom - height))), width, height };
  }

  function sendState() {
    if (active && loaded && window && !window.isDestroyed()) {
      window.webContents.send('widget-menu-state', active);
    }
  }
  function close(reason = 'dismiss') {
    if (!active) return;
    const previous = active;
    active = null;
    clearTimeout(startupTimer);
    startupTimer = null;
    if (window && !window.isDestroyed()) {
      window.webContents.send('widget-menu-state', { requestId: previous.requestId, open: false });
      window.hide();
    }
    onOpenChange(false, reason);
  }
  function fail(error, failedWindow) {
    if (disposed || (failedWindow && window !== failedWindow)) return;
    close('error');
    const previous = window;
    window = null;
    loaded = false;
    if (previous && !previous.isDestroyed()) previous.destroy();
    onError(error);
  }

  function open({ point, modality = 'pointer', presentation, pinned = true }) {
    const owner = getOwner();
    if (disposed || !owner || owner.isDestroyed() || !owner.isVisible() ||
        !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    const requestId = ++sequence;
    active = { requestId, open: true, modality, presentation };
    active.point = { x: Math.round(point.x), y: Math.round(point.y) };
    onOpenChange(true, 'open');
    clearTimeout(startupTimer);
    startupTimer = setTimeout(() => fail(new Error('Menu page did not become ready.')), 5000);
    try {
      if (!window || window.isDestroyed()) {
        const created = new BrowserWindow({
          ...fit(active.point, { width: 300, height: 540 }),
          show: false, frame: false, transparent: true, backgroundColor: '#00000000',
          parent: owner, modal: false, resizable: false, movable: false,
          minimizable: false, maximizable: false, fullscreenable: false,
          skipTaskbar: true, hasShadow: false, title: 'Folia · 小组件菜单',
          webPreferences: webPreferences()
        });
        window = created;
        loaded = false;
        restrictNavigation(created);
        created.on('blur', () => { if (window === created) close('blur'); });
        created.on('closed', () => {
          if (window !== created) return;
          window = null; loaded = false;
          close('closed');
        });
        created.webContents.on('render-process-gone', () => fail(new Error('Menu renderer exited.'), created));
        created.loadFile(path.join(__dirname, 'widget.html'), { query: { menu: '1' } })
          .catch(error => fail(error, created));
      }
      window.setAlwaysOnTop(Boolean(pinned), process.platform === 'win32' ? 'screen-saver' : 'floating');
      sendState();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  function event(event, payload) {
    if (disposed || !window || window.isDestroyed() || event?.sender !== window.webContents ||
        !payload || typeof payload !== 'object') return;
    if (payload.type === 'ready') {
      loaded = true;
      sendState();
      return;
    }
    if (!active || payload.requestId !== active.requestId) return;
    if (payload.type === 'measure') {
      const { width, height } = payload;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || width > 640 || height < 40 || height > 1600) return;
      try {
        const bounds = fit(active.point, { width, height });
        const current = window.getBounds();
        if (['x', 'y', 'width', 'height'].some(key => bounds[key] !== current[key])) window.setBounds(bounds);
        clearTimeout(startupTimer);
        startupTimer = null;
        if (!window.isVisible()) {
          window.show();
          window.focus();
        }
      } catch (error) { fail(error); }
    } else if (payload.type === 'close') {
      close(payload.reason === 'keyboard' ? 'keyboard' : 'dismiss');
    } else if (payload.type === 'select' && actionIds.has(payload.id)) {
      const item = active.presentation?.items?.find(item => item.id === payload.id);
      if (!item || item.hidden || item.disabled) return;
      const id = payload.id;
      close('select');
      onSelect(id);
    }
  }

  return {
    open, close, event,
    owns: candidate => Boolean(window && candidate === window),
    update(presentation) { if (active) { active.presentation = presentation; sendState(); } },
    dispose() {
      close('dispose');
      disposed = true;
      const previous = window;
      window = null;
      if (previous && !previous.isDestroyed()) previous.destroy();
    }
  };
};
