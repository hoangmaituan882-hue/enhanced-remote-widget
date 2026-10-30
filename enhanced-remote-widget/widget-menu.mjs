import { createContextMenu } from './widget-context-menu.mjs';

// Reuse the menu's markup and keyboard owner, but never start a second player,
// settings controller, playback clock, or local-storage writer in this window.
const bridge = window.foliaWidget;
const menu = document.getElementById('menu');
for (const child of [...document.body.children]) if (child !== menu) child.remove();
document.body.className = 'menu-window';
let requestId = null;
let disposed = false;
let resizeFrame = 0;
let suppressClose = false;
let initialized = false;
const textIds = ['menu-layout-text', 'menu-palette-text', 'menu-palette-name',
  'menu-like-text', 'menu-disable-click-through-text'];
const items = new Map([...menu.querySelectorAll('[data-menu-item]')].map(item => [item.id, item]));
const send = (type, value = {}) => {
  if (!disposed && requestId !== null) bridge.send('widget-menu-event', { type, requestId, ...value });
};
const controller = createContextMenu({
  menu, trigger: menu, onBeforeOpen() {}, onOpen() {},
  onClose({ reason, selectedId }) {
    if (suppressClose) return;
    if (selectedId) send('select', { id: selectedId });
    else send('close', { reason });
  },
  onSelect() {}
});

function measure() {
  resizeFrame = 0;
  if (disposed || !controller.isOpen()) return;
  // Width is fixed by CSS; only the popup is fitted to the real menu height.
  // scrollHeight includes content beyond a small work area's viewport.
  const style = getComputedStyle(menu);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  const preferredWidth = parseFloat(style.getPropertyValue('--menu-width')) || menu.getBoundingClientRect().width;
  send('measure', { width: Math.ceil(preferredWidth + 16),
    height: Math.ceil(menu.scrollHeight + border + 16) });
}
function scheduleMeasure() {
  if (!disposed && !resizeFrame) resizeFrame = requestAnimationFrame(measure);
}
function apply(presentation = {}) {
  for (const name of [...document.body.classList]) if (name.startsWith('mode-')) document.body.classList.remove(name);
  for (const name of presentation.classes || []) {
    if (/^mode-[a-z-]+$/.test(name)) document.body.classList.add(name);
  }
  for (const id of textIds) {
    const value = presentation.text?.[id];
    if (typeof value === 'string') document.getElementById(id).textContent = value;
  }
  for (const value of presentation.items || []) {
    const item = items.get(value.id);
    if (!item) continue;
    item.hidden = Boolean(value.hidden);
    item.disabled = Boolean(value.disabled);
    item.classList.toggle('liked', Boolean(value.liked));
    item.dataset.label = typeof value.label === 'string' ? value.label : '';
    item.title = typeof value.title === 'string' ? value.title : '';
    if (typeof value.ariaLabel === 'string') item.setAttribute('aria-label', value.ariaLabel);
    if (value.checked === 'true' || value.checked === 'false') {
      item.setAttribute('aria-checked', value.checked);
      const check = item.querySelector('.menu-check');
      if (check) check.style.display = value.checked === 'true' ? 'inline' : 'none';
    }
  }
  const playing = Boolean(presentation.playing);
  document.getElementById('menu-icon-play').style.opacity = playing ? '0' : '1';
  document.getElementById('menu-icon-pause').style.opacity = playing ? '1' : '0';
  document.getElementById('menu-icon-play').setAttribute('aria-hidden', String(playing));
  document.getElementById('menu-icon-pause').setAttribute('aria-hidden', String(!playing));
}
bridge.on('widget-menu-state', (_event, value) => {
  if (!value || !Number.isSafeInteger(value.requestId)) return;
  if (!value.open) {
    if (value.requestId !== requestId) return;
    suppressClose = true;
    controller.close();
    suppressClose = false;
    requestId = null;
    return;
  }
  const reopening = value.requestId !== requestId;
  requestId = value.requestId;
  apply(value.presentation);
  if (!initialized) { initialized = true; document.body.style.visibility = 'visible'; }
  if (reopening || !controller.isOpen()) {
    suppressClose = true;
    controller.close();
    suppressClose = false;
    controller.open(8, 8, value.modality || 'pointer');
  }
  // A hidden BrowserWindow can throttle animation frames; the first size
  // handshake must not depend on becoming visible before it can show.
  measure();
});
const observer = new window.ResizeObserver(scheduleMeasure);
observer.observe(menu);
menu.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('blur', () => controller.close());
window.addEventListener('pagehide', () => {
  disposed = true;
  observer.disconnect();
  cancelAnimationFrame(resizeFrame);
  controller.dispose();
}, { once: true });
bridge.send('widget-menu-event', { type: 'ready' });
