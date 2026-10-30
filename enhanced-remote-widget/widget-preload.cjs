'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const query = new URLSearchParams(location.search);
const settingsPage = query.has('settings');
const menuPage = !settingsPage && query.has('menu');
const role = settingsPage ? 'settings' : menuPage ? 'menu' : 'player';
const sends = new Set(menuPage ? ['widget-menu-event'] : settingsPage
  ? ['widget-settings-ready', 'widget-settings-action', 'widget-settings-close', 'widget-fonts-request']
  : ['widget-action', 'widget-window-cmd', 'widget-request-window-state', 'widget-request-snapshot', 'widget-settings-state']);
const receives = new Set(menuPage ? ['widget-menu-state'] : settingsPage
  ? ['widget-settings-state', 'widget-fonts']
  : ['widget-update', 'widget-announcement', 'widget-visibility', 'widget-window-state', 'widget-resized',
    'show-context-menu', 'widget-settings-request-state', 'widget-settings-action',
    'widget-menu-visibility', 'widget-menu-selected']);
const listeners = new Set();

contextBridge.exposeInMainWorld('foliaWidget', Object.freeze({
  role,
  send(channel, payload) {
    if (sends.has(channel)) ipcRenderer.send(channel, payload);
  },
  on(channel, callback) {
    if (!receives.has(channel) || typeof callback !== 'function') return () => {};
    // Never expose the Electron event or its sender to the page.
    const listener = (_event, payload) => callback(null, payload);
    const entry = { channel, listener };
    listeners.add(entry);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); listeners.delete(entry); };
  }
}));

window.addEventListener('pagehide', () => {
  for (const { channel, listener } of listeners) ipcRenderer.removeListener(channel, listener);
  listeners.clear();
}, { once: true });
