// remote-control-widget/index.cjs
// Node.js 主进程入口：管理桌面独立悬浮小组件 BrowserWindow、自由拉伸、磁吸与 IPC 通信
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const createWindowLayouts = require('./window-layouts.cjs');
const createWidgetVisibility = require('./widget-visibility.cjs');
const createWindowMover = require('./window-move.cjs');
const createRightClickMonitor = require('./window-right-click.cjs');
const createMenuWindow = require('./window-menu.cjs');

const transientInteractions = ['pointer', 'menu', 'editor'];
const windowPreferences = () => ({
  preload: path.join(__dirname, 'widget-preload.cjs'),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  backgroundThrottling: true
});

function restrictWindowNavigation(window, settingsPage = false) {
  const entry = pathToFileURL(path.join(__dirname, 'widget.html'));
  if (settingsPage === 'menu') entry.searchParams.set('menu', '1');
  else if (settingsPage) entry.searchParams.set('settings', '1');
  // Allow reloading this document, but never replacing it or changing roles.
  window.webContents.on('will-navigate', (event, url) => {
    if ((event.url ?? url) !== entry.href) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

try {
  if (app && !app.isReady()) {
    app.commandLine.appendSwitch('enable-font-antialiasing');
    app.commandLine.appendSwitch('font-render-hinting', 'slight');
  }
} catch (e) {}


let systemFonts = null;
// 系统字体列表：设置页歌词字体下拉用；首次请求时读取一次并缓存。
function listSystemFonts() {
  if (systemFonts) return systemFonts;
  if (process.platform !== 'win32') return (systemFonts = []);
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    systemFonts = [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  } catch {
    systemFonts = [];
  }
  return systemFonts;
}

module.exports = function activate(api) {
  const moveWindow = createWindowMover((error, position) => {
    api.log.warn(`组件移动失败 (${position.x}, ${position.y}): ${error.message}`);
  });
  let widgetWindow = null;
  let settingsWindow = null;
  let isDisposed = false;
  let creationPromise = null;
  let shouldShowWidget = true;
  let isAlwaysOnTop = true;
  let pendingLayoutAnchor = null;
  let clickThroughRequested = false;
  let menuInteractionActive = false;
  let needsInteractionRecovery = false;
  let rendererReady = false;
  const menuWindow = createMenuWindow({
    BrowserWindow, screen, getOwner: () => widgetWindow, webPreferences: windowPreferences,
    restrictNavigation: window => restrictWindowNavigation(window, 'menu'),
    onOpenChange(active, reason) {
      menuInteractionActive = active;
      visibility.hold('menu', active);
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.webContents.send('widget-menu-visibility', { open: active, reason });
        if (!active && reason === 'keyboard' && widgetWindow.isVisible()) widgetWindow.focus();
      }
      syncMouseEvents();
    },
    onSelect(id) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget-menu-selected', id);
    },
    onError(error) { api.log.warn('打开小组件菜单失败: ' + error.message); }
  });
  const rightClickMonitor = createRightClickMonitor({
    getWindow: () => widgetWindow,
    onReady: () => syncMouseEvents(),
    onClick(point) {
      if (isDisposed || !clickThroughRequested || menuInteractionActive || !rendererReady || settingsWindow ||
          !widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return;
      const cursor = screen.screenToDipPoint(point);
      const bounds = widgetWindow.getBounds();
      const x = Math.round(cursor.x - bounds.x);
      const y = Math.round(cursor.y - bounds.y);
      if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;
      // The menu takes focus in its own popup; the lyrics stay click-through.
      menuInteractionActive = true;
      widgetWindow.webContents.send('show-context-menu', { x, y });
    },
    onError(error) {
      if (isDisposed) return;
      api.log.warn('点击穿透右键入口不可用，已恢复鼠标交互: ' + error.message);
      clickThroughRequested = false;
      syncMouseEvents();
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.webContents.send('widget-settings-action', { type: 'click-through-unavailable' });
      }
    }
  });
  // Windows can bring another topmost Folia window above the widget on focus.
  // Restore z-order without taking keyboard focus from that window.
  function raisePinnedWidget() {
    if (isDisposed || !isAlwaysOnTop || !widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return;
    try {
      widgetWindow.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
      widgetWindow.moveTop();
    } catch (error) {
      api.log.warn(`组件置顶失败: ${error.message}`);
    }
  }
  const onFoliaWindowFocus = (_event, focusedWindow) => {
    if (focusedWindow === widgetWindow || focusedWindow === settingsWindow || menuWindow.owns(focusedWindow)) return;
    setImmediate(raisePinnedWidget);
  };
  const actionQueue = [];
  let pendingActionResolver = null;
  let pollTimeoutTimer = null;
  const windowLayouts = createWindowLayouts(api, screen);
  const saveBounds = (bounds, profileMode = 'full') => windowLayouts.remember(bounds, profileMode);
  // 渲染端刚起来时只有增量状态，向 client 要一次带歌词的全量快照（Folium 1.7 起可用）。
  function requestFullState() {
    try { if (typeof api.rpc.send === 'function') api.rpc.send('request-state', { full: true }); } catch {}
  }
  const visibility = createWidgetVisibility({
    presentAnnouncement(active) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget-announcement', active);
    },
    present(phase) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget-visibility', phase);
    },
    show() {
      if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) return;
      widgetWindow.webContents.send('widget-announcement', visibility.isAnnouncing());
      widgetWindow.webContents.send('widget-update', latestState);
      widgetWindow.showInactive();
      raisePinnedWidget();
    },
    hide() {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
    }
  });
  function snappedPosition(bounds) {
    let { x, y } = bounds;
    try {
      const area = screen.getDisplayMatching(bounds).workArea;
      const threshold = 18;
      if (Math.abs(x - area.x) < threshold) x = area.x;
      else if (Math.abs(x + bounds.width - area.x - area.width) < threshold) x = area.x + area.width - bounds.width;
      if (Math.abs(y - area.y) < threshold) y = area.y;
      else if (Math.abs(y + bounds.height - area.y - area.height) < threshold) y = area.y + area.height - bounds.height;
    } catch {}
    return { x, y };
  }
  function notifyWindowState() {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send('widget-window-state', windowLayouts.snapshot(widgetWindow.getBounds()));
    }
  }

  function isWidgetSender(event) {
    return !isDisposed && widgetWindow && !widgetWindow.isDestroyed() && event?.sender === widgetWindow.webContents;
  }
  function isSettingsSender(event) {
    return !isDisposed && settingsWindow && !settingsWindow.isDestroyed() && event?.sender === settingsWindow.webContents;
  }

  function syncMouseEvents() {
    if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) {
      rightClickMonitor.sync(false);
      return;
    }
    const requested = clickThroughRequested &&
      windowLayouts.snapshot(widgetWindow.getBounds()).layout === 'lyrics';
    const ignore = requested && !settingsWindow;
    try {
      // Do not forward mousemove: CSS hover and drawers must remain silent too.
      // Preferences can temporarily admit input; the detached menu never
      // changes the player's hit region. Keep the recovery helper warm.
      rightClickMonitor.sync(requested && widgetWindow.isVisible());
      // Do not lock out input unless the independent right-click exit is ready.
      widgetWindow.setIgnoreMouseEvents(ignore && rightClickMonitor.isReady());
    } catch (error) { api.log.warn('更新小组件鼠标交互失败: ' + error.message); }
  }

  function deliverInteractionRecovery() {
    if (!needsInteractionRecovery || !rendererReady || !widgetWindow || widgetWindow.isDestroyed()) return;
    widgetWindow.webContents.send('widget-settings-action', { type: 'recover-interaction' });
    needsInteractionRecovery = false;
  }

  async function recoverWidget() {
    if (isDisposed) return { visible: false };
    menuWindow.close('recover');
    clickThroughRequested = false;
    needsInteractionRecovery = true;
    visibility.releaseHolds(transientInteractions);
    await createOrShowWidgetWindow();
    if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) return { visible: false };
    syncMouseEvents();
    deliverInteractionRecovery();
    restoreWindowBounds('position');
    return { visible: true };
  }

  function restoreWindowBounds(kind = 'visible') {
    if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) return;
    stopBoundsAnimation();
    pendingLayoutAnchor = null;
    const current = widgetWindow.getBounds();
    const target = kind === 'position' ? windowLayouts.resetPosition(current)
      : kind === 'size' ? windowLayouts.resetSize(current) : windowLayouts.clampBounds(current);
    if (['x', 'y', 'width', 'height'].some(name => current[name] !== target[name])) {
      markTemporaryBounds();
      const [minimumWidth, minimumHeight] = windowLayouts.minimumSize();
      // 极小工作区也必须能找回窗口；不强制超出当前显示器的布局最小尺寸。
      widgetWindow.setMinimumSize(Math.min(minimumWidth, target.width), Math.min(minimumHeight, target.height));
      widgetWindow.setBounds(target);
      saveBounds(widgetWindow.getBounds());
      widgetWindow.webContents.send('widget-resized', widgetWindow.getBounds());
    }
    syncMouseEvents();
    notifyWindowState();
  }
  const onDisplaysChanged = () => { menuWindow.close('display-change'); restoreWindowBounds(); };

  function createOrShowSettingsWindow() {
    if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) return;
    menuWindow.close('settings');
    visibility.hold('settings', true);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (!settingsWindow.webContents.isLoading()) {
        settingsWindow.show();
        settingsWindow.focus();
        widgetWindow.webContents.send('widget-settings-request-state');
      }
      return;
    }
    const owner = widgetWindow;
    const created = new BrowserWindow({
      width: 560, height: 640, minWidth: 400, minHeight: 440,
      show: false, frame: true, transparent: false, resizable: true,
      backgroundColor: '#f5f5f7', title: '偏好设置 · Folia 增强版悬浮小组件',
      parent: owner, modal: false, autoHideMenuBar: true,
      webPreferences: windowPreferences()
    });
    settingsWindow = created;
    syncMouseEvents();
    restrictWindowNavigation(created, true);
    created.loadFile(path.join(__dirname, 'widget.html'), { query: { settings: '1' } }).catch(err => {
      if (!isDisposed) api.log.error('加载设置窗口失败: ' + err.message);
      if (!created.isDestroyed()) created.destroy();
    });
    created.once('ready-to-show', () => {
      if (isDisposed || created.isDestroyed()) return;
      created.show();
      created.focus();
    });
    created.on('closed', () => {
      if (settingsWindow === created) settingsWindow = null;
      syncMouseEvents();
      visibility.hold('settings', false);
    });
  }

  function createBezier(x1, y1, x2, y2) {
    const ax = 1 - 3 * x2 + 3 * x1;
    const bx = 3 * x2 - 6 * x1;
    const cx = 3 * x1;
    const ay = 1 - 3 * y2 + 3 * y1;
    const by = 3 * y2 - 6 * y1;
    const cy = 3 * y1;

    function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
    function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
    function sampleXDeriv(t) { return (3 * ax * t + 2 * bx) * t + cx; }

    return function solve(x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const xCurrent = sampleX(t) - x;
        if (Math.abs(xCurrent) < 1e-5) return sampleY(t);
        const dxdt = sampleXDeriv(t);
        if (Math.abs(dxdt) < 1e-5) break;
        t -= xCurrent / dxdt;
      }
      let t0 = 0, t1 = 1;
      t = x;
      while (t0 < t1) {
        const xCurrent = sampleX(t);
        if (Math.abs(xCurrent - x) < 1e-5) return sampleY(t);
        if (x > xCurrent) t0 = t;
        else t1 = t;
        t = (t1 + t0) / 2;
        if (t1 - t0 < 1e-4) break;
      }
      return sampleY(t);
    };
  }

  let boundsAnimationTimer = null;
  let isAnimatingBounds = false;
  let suppressBoundsSave = false;
  let suppressBoundsTimer = null;

  function markTemporaryBounds() {
    suppressBoundsSave = true;
    clearTimeout(suppressBoundsTimer);
    suppressBoundsTimer = setTimeout(() => { suppressBoundsSave = false; suppressBoundsTimer = null; }, 120);
  }

  function stopBoundsAnimation() {
    if (boundsAnimationTimer) {
      clearInterval(boundsAnimationTimer);
      boundsAnimationTimer = null;
    }
    isAnimatingBounds = false;
  }

  function animateWindowBounds(targetBounds, duration = 240, onComplete, shouldSave = true) {
    stopBoundsAnimation();
    if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) return;

    const startBounds = widgetWindow.getBounds();
    const targetX = Number.isFinite(targetBounds.x) ? Math.round(targetBounds.x) : startBounds.x;
    const targetY = Number.isFinite(targetBounds.y) ? Math.round(targetBounds.y) : startBounds.y;
    const targetW = Number.isFinite(targetBounds.width) ? Math.round(targetBounds.width) : startBounds.width;
    const targetH = Number.isFinite(targetBounds.height) ? Math.round(targetBounds.height) : startBounds.height;

    const dx = targetX - startBounds.x;
    const dy = targetY - startBounds.y;
    const dw = targetW - startBounds.width;
    const dh = targetH - startBounds.height;

    if (duration <= 0 || (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dw) < 1 && Math.abs(dh) < 1)) {
      if (!shouldSave) markTemporaryBounds();
      widgetWindow.setMinimumSize(...windowLayouts.minimumSize());
      widgetWindow.setBounds({ x: targetX, y: targetY, width: targetW, height: targetH });
      if (shouldSave) saveBounds(widgetWindow.getBounds(), 'full');
      notifyWindowState();
      if (typeof onComplete === 'function') onComplete();
      return;
    }

    const [minW, minH] = windowLayouts.minimumSize();
    const tempMinW = Math.min(startBounds.width, targetW, minW);
    const tempMinH = Math.min(startBounds.height, targetH, minH);
    try {
      widgetWindow.setMinimumSize(Math.max(100, tempMinW), Math.max(80, tempMinH));
    } catch {}

    const startTime = Date.now();
    const ease = createBezier(0.2, 0, 0, 1);
    isAnimatingBounds = true;

    boundsAnimationTimer = setInterval(() => {
      if (isDisposed || !widgetWindow || widgetWindow.isDestroyed()) {
        stopBoundsAnimation();
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      const factor = ease(progress);

      if (progress >= 1) {
        stopBoundsAnimation();
        try {
          if (!shouldSave) markTemporaryBounds();
          widgetWindow.setMinimumSize(...windowLayouts.minimumSize());
          widgetWindow.setBounds({ x: targetX, y: targetY, width: targetW, height: targetH });
          const finalBounds = widgetWindow.getBounds();
          if (shouldSave) saveBounds(finalBounds, 'full');
          widgetWindow.webContents.send('widget-resized', finalBounds);
          notifyWindowState();
        } catch {}
        if (typeof onComplete === 'function') onComplete();
        return;
      }

      const currentBounds = {
        x: Math.round(startBounds.x + dx * factor),
        y: Math.round(startBounds.y + dy * factor),
        width: Math.round(startBounds.width + dw * factor),
        height: Math.round(startBounds.height + dh * factor)
      };

      try {
        widgetWindow.setBounds(currentBounds);
      } catch {}
    }, 16);
  }

  let latestState = {
    songKey: '',
    songPersistentKey: '',
    title: '未在播放',
    artist: '',
    album: '未知专辑',
    publishTime: '未知发行时间',
    coverUrl: '',
    position: 0,
    duration: 0,
    state: 'stopped',
    liked: false,
    canLike: false,
    lyrics: null,
    currentLyric: '',
    connectionStatus: 'connecting'
  };
  let connectionTimer = null;
  function setConnectionStatus(status) {
    if (latestState.connectionStatus === status) return;
    latestState.connectionStatus = status;
    const connected = status === 'connected';
    visibility.hold('connection', !connected);
    if (!connected) {
      actionQueue.length = 0;
      pendingActionResolver?.(null);
    }
  }
  function watchConnection() {
    clearTimeout(connectionTimer);
    // 容忍后台节流与短暂停顿；超时只表示同步过期，不伪造宿主暂停。
    connectionTimer = setTimeout(() => {
      connectionTimer = null;
      setConnectionStatus('stale');
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.webContents.send('widget-update', { connectionStatus: 'stale' });
      }
    }, 15000);
  }
  visibility.hold('connection', true);
  watchConnection();

  // 创建或显示增强版桌面悬浮小组件窗口
  function createOrShowWidgetWindow() {
    if (isDisposed) return Promise.resolve();
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      shouldShowWidget = true;
      visibility.manual(true);
      restoreWindowBounds();
      widgetWindow.focus();
      return Promise.resolve();
    }

    if (creationPromise) return creationPromise;
    shouldShowWidget = true;
    creationPromise = createWidgetWindow().finally(() => { creationPromise = null; });
    return creationPromise;
  }

  async function createWidgetWindow() {

    const bounds = await windowLayouts.load();
    if (isDisposed) return;
    const [minimumWidth, minimumHeight] = windowLayouts.minimumSize();

    widgetWindow = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Folia 增强版悬浮小组件',
      alwaysOnTop: isAlwaysOnTop,
      resizable: true, // 开启自由边缘调整支持
      minWidth: Math.min(minimumWidth, bounds.width),
      minHeight: Math.min(minimumHeight, bounds.height),
      maxWidth: 800,
      maxHeight: 600,
      minimizable: false,
      maximizable: false,
      skipTaskbar: false,
      webPreferences: windowPreferences()
    });

    restrictWindowNavigation(widgetWindow);
    widgetWindow.on('show', syncMouseEvents);
    widgetWindow.on('hide', () => { menuWindow.close('owner-hidden'); syncMouseEvents(); });
    const releasePageInteractions = () => {
      menuWindow.close('owner-navigation');
      visibility.releaseHolds(transientInteractions);
      // 新页面尚未就绪或渲染进程退出时，不能遗留一个永久忽略鼠标的窗口。
      rendererReady = false;
      menuInteractionActive = false;
      clickThroughRequested = false;
      syncMouseEvents();
    };
    widgetWindow.webContents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => {
      const isMainFrame = details?.isMainFrame ?? mainFrame;
      const isSameDocument = details?.isSameDocument ?? inPlace;
      if (isMainFrame && !isSameDocument) releasePageInteractions();
    });
    widgetWindow.webContents.on('render-process-gone', releasePageInteractions);

    widgetWindow.setAlwaysOnTop(isAlwaysOnTop, process.platform === 'win32' ? 'screen-saver' : 'floating');

    // Windows 平台：-webkit-app-region: drag 会使窗口区域被 Windows 判定为 HTCAPTION (非客户区)
    // 导致 DOM 无法接收到原生 contextmenu 事件。通过 Hook Win32 消息精准捕获右键动作：
    if (process.platform === 'win32' && typeof widgetWindow.hookWindowMessage === 'function') {
      const handleRightClick = () => {
        if (isDisposed || clickThroughRequested || !widgetWindow || widgetWindow.isDestroyed()) return;
        try {
          const cursor = screen.getCursorScreenPoint();
          const bounds = widgetWindow.getBounds();
          const x = Math.round(cursor.x - bounds.x);
          const y = Math.round(cursor.y - bounds.y);
          widgetWindow.webContents.send('show-context-menu', { x, y });
        } catch {}
      };
      widgetWindow.hookWindowMessage(0x00A5, handleRightClick); // WM_NCRBUTTONUP
      widgetWindow.hookWindowMessage(0x007B, handleRightClick); // WM_CONTEXTMENU
    }

    widgetWindow.webContents.on('context-menu', (event, params) => {
      if (isDisposed || clickThroughRequested || !widgetWindow || widgetWindow.isDestroyed()) return;
      widgetWindow.webContents.send('show-context-menu', { x: params.x, y: params.y });
    });

    const createdWindow = widgetWindow;
    createdWindow.loadFile(path.join(__dirname, 'widget.html')).catch((err) => {
      if (!isDisposed) api.log.error('加载小组件界面失败: ' + err.message);
    });

    widgetWindow.once('ready-to-show', () => {
      if (isDisposed || createdWindow.isDestroyed() || !shouldShowWidget) return;
      createdWindow.webContents.send('widget-announcement', visibility.isAnnouncing());
      createdWindow.webContents.send('widget-update', latestState);
      if (visibility.canShow()) createdWindow.showInactive();
      visibility.reconcile();
    });

    // 屏幕边缘 18px 磁吸贴边与移动记忆
    widgetWindow.on('moved', () => {
      if (!isDisposed && widgetWindow && !widgetWindow.isDestroyed() && !isAnimatingBounds && !suppressBoundsSave) {
        const currentBounds = widgetWindow.getBounds();
        try {
          const { x: newX, y: newY } = snappedPosition(currentBounds);

          if (newX !== currentBounds.x || newY !== currentBounds.y) {
            widgetWindow.setPosition(newX, newY);
          }

          saveBounds({
            x: newX,
            y: newY,
            width: currentBounds.width,
            height: currentBounds.height
          });
          notifyWindowState();
        } catch (err) {
          // ignore
        }
      }
    });

    // 窗口尺寸调整记忆并广播通知前端
    widgetWindow.on('resized', () => {
      if (!isDisposed && widgetWindow && !widgetWindow.isDestroyed() && !isAnimatingBounds && !suppressBoundsSave) {
        const currentBounds = widgetWindow.getBounds();
        saveBounds(currentBounds);
        widgetWindow.webContents.send('widget-resized', currentBounds);
        notifyWindowState();
      }
    });

    widgetWindow.on('closed', () => {
      releasePageInteractions();
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      if (widgetWindow === createdWindow) widgetWindow = null;
    });
  }

  // 1. RPC 接口供渲染进程 (client.mjs) 同步状态与轮询操作
  api.rpc.handle('syncState', async (state) => {
    if (isDisposed) return { ok: false };
    if (state && typeof state === 'object') {
      if (state.connectionStatus === 'unavailable') {
        clearTimeout(connectionTimer);
        connectionTimer = null;
        setConnectionStatus('unavailable');
        if (widgetWindow && !widgetWindow.isDestroyed()) {
          widgetWindow.webContents.send('widget-update', { connectionStatus: 'unavailable' });
        }
        return { ok: true };
      }
      const { connectionStatus: _reportedStatus, ...patch } = state;
      const hasPlayback = typeof patch.songKey === 'string' && ['playing', 'paused', 'stopped', 'loading', 'buffering'].includes(patch.state) &&
        Number.isFinite(patch.position) && Number.isFinite(patch.duration);
      const reconnecting = hasPlayback && latestState.connectionStatus !== 'connected';
      if (hasPlayback) {
        setConnectionStatus('connected');
        watchConnection();
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'songKey') && patch.songKey !== latestState.songKey) {
        latestState = { ...latestState, lyrics: null, currentLyric: '', songPersistentKey: '' };
      }
      latestState = {
        ...latestState,
        ...patch
      };
      // 操作提示只用于本次广播，不在重开窗口时重新播报。
      delete latestState.wheelFeedback;
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        // 完整快照只在打开窗口时发送，常规同步沿用客户端的增量载荷。
        widgetWindow.webContents.send('widget-update', { ...patch, connectionStatus: latestState.connectionStatus });
      }
      if (hasPlayback) visibility.updatePlayback(latestState.state, latestState.songKey);
      if (reconnecting && !Object.prototype.hasOwnProperty.call(patch, 'lyrics')) requestFullState();
    }
    return { ok: true };
  });

  api.rpc.handle('getPlaybackSnapshot', () => isDisposed ? null : api.runtime.getPlaybackSnapshot());

  // 操作长轮询：支持批量拉取 pollActions 与单条兼容 pollAction
  api.rpc.handle('pollActions', () => {
    if (isDisposed || latestState.connectionStatus !== 'connected') return [];
    if (pendingActionResolver) pendingActionResolver(null);
    if (actionQueue.length > 0) {
      const items = actionQueue.splice(0, actionQueue.length);
      return items;
    }
    return new Promise((resolve) => {
      if (pollTimeoutTimer) clearTimeout(pollTimeoutTimer);
      pendingActionResolver = (action) => {
        if (pollTimeoutTimer) clearTimeout(pollTimeoutTimer);
        pollTimeoutTimer = null;
        pendingActionResolver = null;
        resolve(action ? [action] : []);
      };
      // 15 秒安全超时返回空数组，让长轮询优雅重建，防止 Electron IPC 挂死
      pollTimeoutTimer = setTimeout(() => {
        if (pendingActionResolver) pendingActionResolver(null);
      }, 15000);
    });
  });

  api.rpc.handle('pollAction', () => {
    if (isDisposed || latestState.connectionStatus !== 'connected') return null;
    if (pendingActionResolver) pendingActionResolver(null);
    if (actionQueue.length > 0) {
      return actionQueue.shift();
    }
    return new Promise((resolve) => {
      if (pollTimeoutTimer) clearTimeout(pollTimeoutTimer);
      pendingActionResolver = (action) => {
        if (pollTimeoutTimer) clearTimeout(pollTimeoutTimer);
        pollTimeoutTimer = null;
        pendingActionResolver = null;
        resolve(action || null);
      };
      pollTimeoutTimer = setTimeout(() => {
        if (pendingActionResolver) pendingActionResolver(null);
      }, 15000);
    });
  });

  // 切换悬浮小组件的显示/隐藏
  api.rpc.handle('toggleWidget', async () => {
    if (isDisposed) return { visible: false };
    if (shouldShowWidget && (creationPromise || (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()))) {
      shouldShowWidget = false;
      visibility.manual(false);
      return { visible: false };
    } else {
      shouldShowWidget = true;
      visibility.manual(true);
      await createOrShowWidgetWindow();
      return { visible: !isDisposed && shouldShowWidget };
    }
  });

  api.rpc.handle('recoverWidget', recoverWidget);
  api.rpc.handle('openWidgetSettings', async () => {
    if (isDisposed) return { visible: false };
    await createOrShowWidgetWindow();
    if (isDisposed) return { visible: false };
    createOrShowSettingsWindow();
    return { visible: Boolean(settingsWindow && !settingsWindow.isDestroyed()) };
  });

  // 2. 监听来自 widget.html 的 IPC 控制指令
  const onWidgetAction = (event, payload) => {
    if (!isWidgetSender(event) || latestState.connectionStatus !== 'connected' || !payload || !['play', 'pause', 'toggle', 'next', 'previous', 'seek', 'volumeDelta', 'toggleLike', 'shuffle'].includes(payload.action)) return;
    if (payload.action === 'seek') {
      if (!Number.isFinite(payload.value) || (typeof payload.songKey === 'string' && payload.songKey !== latestState.songKey)) return;
      payload = { action: 'seek', value: payload.value, songKey: latestState.songKey };
    }
    if (payload.action === 'volumeDelta') {
      if (!Number.isFinite(payload.value) || payload.value === 0) return;
      payload = { action: 'volumeDelta', value: Math.max(-.1, Math.min(.1, payload.value)) };
    }
    if (pendingActionResolver) {
      const resolve = pendingActionResolver;
      pendingActionResolver = null;
      resolve(payload);
    } else {
      // 连续进度调整只保留最终目标；按钮操作仍保持原有顺序。
      if (payload.action === 'seek' && actionQueue[actionQueue.length - 1]?.action === 'seek') {
        actionQueue[actionQueue.length - 1] = payload;
      } else {
        actionQueue.push(payload);
      }
    }
  };

  const onWidgetWindowCmd = (event, payload) => {
    if (!isWidgetSender(event) || !payload || typeof payload !== 'object') return;
    const { cmd, value } = payload;
    if (cmd === 'renderer-ready') {
      rendererReady = true;
      visibility.releaseHolds(transientInteractions);
      deliverInteractionRecovery();
      requestFullState();
    } else if (cmd === 'open-menu') {
      if (!rendererReady || !value || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
          !value.presentation || typeof value.presentation !== 'object') return;
      const bounds = widgetWindow.getBounds();
      menuWindow.open({
        point: { x: bounds.x + Math.max(0, Math.min(bounds.width, value.x)),
          y: bounds.y + Math.max(0, Math.min(bounds.height, value.y)) },
        modality: ['pointer', 'keyboard', 'touch'].includes(value.modality) ? value.modality : 'pointer',
        presentation: value.presentation, pinned: isAlwaysOnTop
      });
    } else if (cmd === 'close-menu') {
      menuWindow.close();
    } else if (cmd === 'menu-state') {
      if (value && typeof value === 'object') menuWindow.update(value);
    } else if (cmd === 'close') {
      menuWindow.close('owner-hidden');
      shouldShowWidget = false;
      visibility.manual(false);
    } else if (cmd === 'open-settings') {
      createOrShowSettingsWindow();
    } else if (cmd === 'auto-hide') {
      visibility.setEnabled(value);
    } else if (cmd === 'song-announcement') {
      visibility.setAnnouncementEnabled(value);
    } else if (cmd === 'interaction') {
      if (value && ['pointer', 'menu', 'editor'].includes(value.kind) && typeof value.active === 'boolean') {
        visibility.hold(value.kind, value.active);
        if (value.kind === 'menu') {
          menuInteractionActive = value.active;
          syncMouseEvents();
        }
      }
    } else if (cmd === 'click-through') {
      if (typeof value !== 'boolean') return;
      clickThroughRequested = value;
      syncMouseEvents();
    } else if (cmd === 'pin') {
      isAlwaysOnTop = Boolean(value);
      widgetWindow.setAlwaysOnTop(isAlwaysOnTop, process.platform === 'win32' ? 'screen-saver' : 'floating');
      raisePinnedWidget();
    } else if (cmd === 'reset-position' || cmd === 'reset-size') {
      restoreWindowBounds(cmd === 'reset-position' ? 'position' : 'size');
    } else if (cmd === 'layout') {
      if (!value || typeof value !== 'object') return;
      const anchorSource = pendingLayoutAnchor || widgetWindow.getBounds();
      const bounds = windowLayouts.switchLayout(
        value.layout,
        anchorSource,
        value.initialize === true
      );
      if (!bounds) return;
      syncMouseEvents();
      if (value.initialize === true) {
        pendingLayoutAnchor = null;
        widgetWindow.setMinimumSize(...windowLayouts.minimumSize());
        widgetWindow.setBounds(bounds);
        saveBounds(widgetWindow.getBounds());
        notifyWindowState();
      } else {
        pendingLayoutAnchor = anchorSource;
        animateWindowBounds(bounds, value.animate === false ? 0 : 240, () => {
          pendingLayoutAnchor = null;
        });
      }
    } else if (cmd === 'resize') {
      pendingLayoutAnchor = null;
      if (value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
        const [minimumWidth, minimumHeight] = windowLayouts.minimumSize();
        const w = Math.max(minimumWidth, Math.min(800, Math.round(value.width)));
        const h = Math.max(minimumHeight, Math.min(600, Math.round(value.height)));
        const [width, height] = widgetWindow.getSize();
        if (width === w && height === h) return;
        const shouldSave = value.save !== false;
        if (value.animate) {
          const currentBounds = widgetWindow.getBounds();
          const targetBounds = windowLayouts.clampBounds({ ...currentBounds, width: w, height: h });
          animateWindowBounds(targetBounds, 240, undefined, shouldSave);
        } else {
          // 拖拽会连续提交尺寸，不叠加原生窗口缩放动画。
          stopBoundsAnimation();
          if (!shouldSave) markTemporaryBounds();
          widgetWindow.setSize(w, h, false);
          const currentBounds = widgetWindow.getBounds();
          if (shouldSave) saveBounds(currentBounds, 'full');
          widgetWindow.webContents.send('widget-resized', currentBounds);
          notifyWindowState();
        }
      }
    } else if (cmd === 'move') {
      if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
      pendingLayoutAnchor = null;
      stopBoundsAnimation();
      // Moving owns position only: never feed CSS viewport dimensions into native size.
      const current = widgetWindow.getBounds();
      let position = { x: Math.round(value.x), y: Math.round(value.y) };
      const shouldSave = value.save !== false;
      if (shouldSave) position = snappedPosition({ ...current, ...position });
      markTemporaryBounds();
      if (!moveWindow(widgetWindow, position.x, position.y, value.begin === true, shouldSave)) return;
      if (shouldSave) saveBounds(widgetWindow.getBounds(), 'position');
      notifyWindowState();
    } else if (cmd === 'set-bounds') {
      pendingLayoutAnchor = null;
      if (value && typeof value === 'object') {
        const bounds = widgetWindow.getBounds();
        for (const key of ['x', 'y', 'width', 'height']) {
          if (Number.isFinite(value[key])) bounds[key] = Math.round(value[key]);
        }
        const [minimumWidth, minimumHeight] = windowLayouts.minimumSize();
        bounds.width = Math.max(minimumWidth, Math.min(800, bounds.width));
        bounds.height = Math.max(minimumHeight, Math.min(600, bounds.height));
        const shouldSave = value.save !== false;
        if (value.animate) {
          animateWindowBounds(windowLayouts.clampBounds(bounds), 240, undefined, shouldSave);
        } else {
          stopBoundsAnimation();
          if (!shouldSave) markTemporaryBounds();
          widgetWindow.setBounds(bounds);
          if (shouldSave) saveBounds(widgetWindow.getBounds());
          notifyWindowState();
        }
      }
    }
  };

  const onWidgetRequestSnapshot = (event) => {
    if (!isWidgetSender(event)) return;
    event.reply('widget-announcement', visibility.isAnnouncing());
    event.reply('widget-update', latestState);
  };
  const onWidgetRequestWindowState = event => {
    if (!isWidgetSender(event)) return;
    event.reply('widget-window-state', windowLayouts.snapshot(widgetWindow.getBounds()));
  };
  const onSettingsReady = event => {
    if (isSettingsSender(event) && widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send('widget-settings-request-state');
    }
  };
  const onSettingsState = (event, snapshot) => {
    if (isWidgetSender(event) && settingsWindow && !settingsWindow.isDestroyed() && snapshot && typeof snapshot === 'object') {
      settingsWindow.webContents.send('widget-settings-state', snapshot);
    }
  };
  const onSettingsAction = (event, action) => {
    if (isSettingsSender(event) && widgetWindow && !widgetWindow.isDestroyed() && action && typeof action === 'object') {
      if (action.type === 'recover-interaction') {
        recoverWidget().catch(error => api.log.error('恢复小组件交互失败: ' + error.message));
      } else if (action.type === 'window-reset' && ['position', 'size'].includes(action.value)) {
        restoreWindowBounds(action.value);
      } else widgetWindow.webContents.send('widget-settings-action', action);
    }
  };
  const onSettingsClose = event => {
    if (isSettingsSender(event)) settingsWindow.close();
  };

  const onMenuEvent = (event, payload) => menuWindow.event(event, payload);
  ipcMain.on('widget-menu-event', onMenuEvent);
  ipcMain.on('widget-action', onWidgetAction);
  ipcMain.on('widget-window-cmd', onWidgetWindowCmd);
  ipcMain.on('widget-request-snapshot', onWidgetRequestSnapshot);
  ipcMain.on('widget-request-window-state', onWidgetRequestWindowState);
  ipcMain.on('widget-settings-ready', onSettingsReady);
  ipcMain.on('widget-settings-state', onSettingsState);
  ipcMain.on('widget-settings-action', onSettingsAction);
  const onFontsRequest = (event) => {
    if (!isWidgetSender(event) && !isSettingsSender(event)) return;
    event.reply('widget-fonts', listSystemFonts());
  };
  ipcMain.on('widget-settings-close', onSettingsClose);
  ipcMain.on('widget-fonts-request', onFontsRequest);
  app.on('browser-window-focus', onFoliaWindowFocus);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, onDisplaysChanged);

  // 默认在激活后自动展示小组件窗口
  const startupTimer = setTimeout(() => {
    if (isDisposed || !shouldShowWidget) return;
    createOrShowWidgetWindow().catch((err) => {
      api.log.error('创建增强版悬浮小组件窗口失败: ' + err.message);
    });
  }, 300);

  // 3. 模组停用时优雅释放
  api.onDispose(() => {
    isDisposed = true;
    rightClickMonitor.dispose();
    menuWindow.dispose();
    ipcMain.removeListener('widget-menu-event', onMenuEvent);
    app.removeListener('browser-window-focus', onFoliaWindowFocus);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, onDisplaysChanged);
    visibility.dispose();
    stopBoundsAnimation();
    clearTimeout(suppressBoundsTimer);
    clearTimeout(startupTimer);
    clearTimeout(pollTimeoutTimer);
    clearTimeout(connectionTimer);
    actionQueue.length = 0;
    ipcMain.removeListener('widget-action', onWidgetAction);
    ipcMain.removeListener('widget-window-cmd', onWidgetWindowCmd);
    ipcMain.removeListener('widget-request-snapshot', onWidgetRequestSnapshot);
    ipcMain.removeListener('widget-request-window-state', onWidgetRequestWindowState);
    ipcMain.removeListener('widget-settings-ready', onSettingsReady);
    ipcMain.removeListener('widget-settings-state', onSettingsState);
    ipcMain.removeListener('widget-settings-action', onSettingsAction);
    ipcMain.removeListener('widget-settings-close', onSettingsClose);
    ipcMain.removeListener('widget-fonts-request', onFontsRequest);

    if (pendingActionResolver) {
      pendingActionResolver(null);
      pendingActionResolver = null;
    }

    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    settingsWindow = null;
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      saveBounds(widgetWindow.getBounds());
      widgetWindow.close();
      widgetWindow = null;
    }
    return windowLayouts.dispose();
  });
};
