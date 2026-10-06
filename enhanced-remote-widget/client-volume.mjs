// Folium 1.x has no public volume setter. Reuse Folia's audio store so its
// player, mute state and saved volume stay in sync; never alter audio elements.
function findAudioStore(values) {
  for (const store of values) {
    if (typeof store?.getState !== 'function') continue;
    try {
      const state = store.getState();
      if (Number.isFinite(state?.volume) && typeof state.handleSetVolume === 'function') return store;
    } catch {}
  }
  return null;
}

export function createVolumeController(folium, isActive = () => true) {
  let pendingStore = null;
  async function getAudioStore() {
    // Prefer a host-provided store when newer Folia versions expose one.
    try {
      const store = findAudioStore(Object.values(folium.internals?.stores || {}));
      if (store) return store;
    } catch {}
    if (!pendingStore) {
      pendingStore = (async () => {
        // 0.7.9 does not expose its audio store through internals.stores.
        // Keep this compatibility adapter inside that verified release only.
        if (folium.host?.folia !== '0.7.9') throw new Error('host-volume-version-unsupported');
        const asset = [...document.querySelectorAll('link[rel="modulepreload"][href]')]
          .map(link => link.href).find(href => /\/omni-[^/]+\.js(?:\?.*)?$/.test(href));
        if (!asset) throw new Error('host-volume-store-unavailable');
        const url = new URL(asset, document.baseURI);
        const page = new URL(document.baseURI);
        // Never import a remote or unrelated script advertised by page content.
        if (url.protocol !== page.protocol || url.origin !== page.origin || url.host !== page.host ||
            (url.protocol === 'file:' && !url.pathname.startsWith(page.pathname.slice(0, page.pathname.lastIndexOf('/') + 1)))) {
          throw new Error('host-volume-asset-untrusted');
        }
        const store = findAudioStore(Object.values(await import(asset)));
        if (!store) throw new Error('host-volume-store-unavailable');
        return store;
      })().catch(error => { pendingStore = null; throw error; });
    }
    return pendingStore;
  }

  return {
    async adjust(delta) {
      if (!Number.isFinite(delta) || delta === 0 || !isActive()) return null;
      const store = await getAudioStore();
      if (!isActive()) return null;
      const audio = store.getState();
      const current = audio.isMuted ? 0 : audio.volume;
      const next = Math.round(Math.max(0, Math.min(1, current + Math.max(-.1, Math.min(.1, delta)))) * 100) / 100;
      audio.handleSetVolume(next);
      if (audio.isMuted && next > 0 && typeof audio.handleToggleMute === 'function') audio.handleToggleMute();
      return next;
    }
  };
}
