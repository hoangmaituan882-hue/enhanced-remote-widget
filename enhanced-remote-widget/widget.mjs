const query = new URLSearchParams(location.search);
const page = query.has('settings') ? './widget-settings-window.mjs'
  : query.has('menu') ? './widget-menu.mjs' : './widget-player.mjs';
import(page);

