const widgetPageQuery = new URLSearchParams(location.search);
if (widgetPageQuery.has('settings')) document.documentElement.classList.add('settings-page');
else if (widgetPageQuery.has('menu')) document.documentElement.classList.add('menu-page');
