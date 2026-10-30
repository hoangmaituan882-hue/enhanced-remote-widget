const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const MOVING = '.cover, .main, .poster-bottom';
// Revealing progress must not translate the playback buttons away from a click.
const FADING = '.row-bottom, .song-title-wrap, .karaoke, .progress, .karaoke-next, .poster-lyric-box, .poster-line-2, .poster-time, .poster-fab, .album-heading, .song-artist-wrap';

const SONG_PARTS = '.cover, .titles, .karaoke, .poster-lyric-box, .lyric-toolbar-title, .circuit-art';

function clonePainted(element, freezeStyles = false) {
  const clone = element.cloneNode(true);
  const originals = [element, ...element.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const style = getComputedStyle(original);
    copy.removeAttribute('id');
    if (freezeStyles) {
      for (const name of style) copy.style.setProperty(name, style.getPropertyValue(name), 'important');
      for (const name of ['animation', 'transition']) copy.style.setProperty(name, 'none', 'important');
      copy.style.setProperty('pointer-events', 'none', 'important');
    }
    copy.style.setProperty('display', style.display, 'important');
    copy.style.setProperty('-webkit-app-region', 'initial', 'important');
    // DOM cloning does not copy Canvas pixels; keep the outgoing lyric glyphs.
    if (original.tagName === 'CANVAS' && original.width > 0 && original.height > 0) {
      try {
        copy.width = original.width;
        copy.height = original.height;
        const context = copy.getContext('2d');
        if (!context) throw new Error('Canvas context unavailable');
        context.drawImage(original, 0, 0);
      } catch {
        copy.parentElement?.classList.remove('lyric-canvas-text');
        copy.style.setProperty('display', 'none', 'important');
      }
    }
  });
  return clone;
}

// Lyric snapshots use visual shells; the live line keeps its own scrolling transform.
export function createLyricMotionController(card, canAnimate) {
  let current = null;
  function restore(entry) {
    if (!entry.held) return;
    entry.held = false;
    if (entry.opacity) entry.element.style.setProperty('opacity', entry.opacity, entry.priority);
    else entry.element.style.removeProperty('opacity');
  }
  function stop() {
    const record = current;
    current = null;
    if (!record) return;
    cancelAnimationFrame(record.frame);
    for (const entry of record.entries) restore(entry);
    for (const animation of record.animations) animation.cancel();
    record.layer.remove();
  }
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return !element.hidden && rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }
  function prepare(elements) {
    stop();
    if (!canAnimate() || typeof card.animate !== 'function') return false;
    const bounds = card.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'lyric-transition-layer';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    const entries = elements.filter(Boolean).map(element => {
      if (visible(element)) {
        const rect = element.getBoundingClientRect();
        const ghost = clonePainted(element, true);
        for (const [name, value] of Object.entries({
          position: 'absolute', margin: '0', transform: 'none',
          left: rect.left - bounds.left - card.clientLeft + 'px',
          top: rect.top - bounds.top - card.clientTop + 'px',
          width: rect.width + 'px', height: rect.height + 'px'
        })) ghost.style.setProperty(name, value, 'important');
        layer.appendChild(ghost);
      }
      return { element, held: true, opacity: element.style.getPropertyValue('opacity'),
        priority: element.style.getPropertyPriority('opacity') };
    });
    if (!layer.childElementCount) return false;
    current = { layer, entries, animations: new Set(), frame: 0 };
    card.appendChild(layer);
    for (const entry of entries) entry.element.style.setProperty('opacity', '0');
    return true;
  }
  function commit() {
    const record = current;
    if (!record || record.frame) return;
    // renderLine queues Canvas measurement first; reveal only after its glyphs are painted.
    record.frame = requestAnimationFrame(() => {
      record.frame = 0;
      if (current !== record) return;
      if (!canAnimate()) { stop(); return; }
      const animate = (element, frames, duration, cleanup = () => {}) => {
        const animation = element.animate(frames, { duration, easing: EASING });
        record.animations.add(animation);
        const finish = () => {
          if (current !== record) return;
          record.animations.delete(animation);
          cleanup();
          if (!record.animations.size) stop();
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      };
      for (const entry of record.entries) {
        restore(entry);
        if (!visible(entry.element)) continue;
        const opacity = getComputedStyle(entry.element).opacity;
        animate(entry.element, [
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity, transform: 'none' }
        ], 220);
      }
      animate(record.layer, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-4px)' }
      ], 180, () => record.layer.remove());
    });
  }
  return { prepare, commit, stop };
}

// Layout changes take effect immediately. Animations never gate input or settings.
export function createMotionController(card) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const runs = new Map();
  const layoutRuns = new Set();
  let pending = null;
  let disposed = false;
  let songLayer = null, songFrame = 0, songLyricsReady = false;
  let songEntries = [];
  const songTargets = new Set();
  const calm = () => disposed || document.hidden || reduced.matches;

  function run(element, frames, duration, layout = false, cleanup = () => {}) {
    runs.get(element)?.cancel();
    if (calm() || typeof element.animate !== 'function') { cleanup(); return; }
    const animation = element.animate(frames, { duration, easing: EASING });
    runs.set(element, animation);
    if (layout) layoutRuns.add(animation);
    const finish = () => {
      if (runs.get(element) === animation) runs.delete(element);
      layoutRuns.delete(animation);
      cleanup();
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }
  function stopLayout() {
    for (const animation of [...layoutRuns]) animation.cancel();
    layoutRuns.clear();
  }
  function stop() {
    cancelSong();
    pending = null;
    for (const animation of [...runs.values()]) animation.cancel();
    runs.clear();
    layoutRuns.clear();
  }
  function prepare() {
    if (pending || calm()) return;
    const records = [...card.querySelectorAll(MOVING + ', ' + FADING)].map(element => {
      const rect = element.getBoundingClientRect();
      const display = getComputedStyle(element).display;
      const visible = display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      let clone = null;
      if (visible && element.matches(FADING)) clone = clonePainted(element);
      return { element, rect, display, visible, clone };
    });
    const style = getComputedStyle(card);
    pending = {
      records, classes: card.className, rect: card.getBoundingClientRect(),
      tokens: ['--type-title', '--type-small', '--type-body', '--lyric-font-size', '--cover-tint', '--poster-title-size', '--poster-fab-size'].map(name => [name, style.getPropertyValue(name)])
    };
    // Capture the current pixels before interrupting a previous transition.
    stopLayout();
  }
  function commit() {
    const before = pending;
    pending = null;
    if (!before || calm() || card.classList.contains('has-overlay')) return;
    const after = new Map(before.records.map(({ element }) => [element, element.getBoundingClientRect()]));
    const hidden = before.records.filter(record => record.visible && record.clone && !(after.get(record.element).width > 0 && after.get(record.element).height > 0));
    // Native resizing changes the clip every frame; keep exits inside the live card.
    const changingFrame = card.classList.contains('is-resizing') || card.classList.contains('is-window-animating');
    const ghosts = changingFrame ? [] : hidden.filter(record => !hidden.some(parent => parent !== record && parent.element.contains(record.element)));
    if (ghosts.length) {
      const currentRect = card.getBoundingClientRect();
      const layer = document.createElement('div');
      layer.className = before.classes + ' motion-layer';
      layer.inert = true;
      layer.setAttribute('aria-hidden', 'true');
      layer.style.setProperty('-webkit-app-region', 'initial', 'important');
      Object.assign(layer.style, {
        left: currentRect.left + 'px', top: currentRect.top + 'px',
        width: currentRect.width + 'px', height: currentRect.height + 'px',
        borderRadius: getComputedStyle(card).borderRadius, overflow: 'hidden', opacity: '0'
      });
      for (const [name, value] of before.tokens) layer.style.setProperty(name, value);
      for (const record of ghosts) {
        Object.assign(record.clone.style, {
          position: 'absolute', margin: '0',
          left: (record.rect.left - currentRect.left) + 'px', top: (record.rect.top - currentRect.top) + 'px',
          width: record.rect.width + 'px', height: record.rect.height + 'px'
        });
        layer.appendChild(record.clone);
      }
      document.body.appendChild(layer);
      run(layer, [{ opacity: 1 }, { opacity: 0 }], 140, true, () => layer.remove());
    }
    for (const record of before.records) {
      const next = after.get(record.element);
      if (!(next.width > 0 && next.height > 0)) continue;
      if (!record.visible) {
        run(record.element, [{ opacity: 0 }, { opacity: 1 }], 180, true);
      } else if (record.element.matches(MOVING)) {
        const x = record.rect.left - next.left;
        const y = record.rect.top - next.top;
        const artwork = record.element.matches('.cover');
        const scale = artwork ? record.rect.width / next.width : 1;
        if (Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(scale - 1) < 0.01) continue;
        // One scale factor preserves the image ratio. CSS eases the clipped
        // frame's dimensions; object-fit keeps the artwork itself undistorted.
        run(record.element, [
          { transform: `translate(${x}px, ${y}px) scale(${scale})`, transformOrigin: '0 0' },
          { transform: 'none', transformOrigin: '0 0' }
        ], 240, true);
      }
    }
  }
  function clearSongWait(entry) {
    clearTimeout(entry.timer);
    entry.image?.removeEventListener('load', entry.loaded);
    entry.image?.removeEventListener('error', entry.loaded);
    entry.waiting = false;
  }
  function restoreSongEntry(entry) {
    if (!entry.held) return;
    entry.held = false;
    if (entry.opacity) entry.element.style.setProperty('opacity', entry.opacity, entry.priority);
    else entry.element.style.removeProperty('opacity');
  }
  function cancelSong() {
    cancelAnimationFrame(songFrame);
    songFrame = 0;
    for (const entry of songEntries) { clearSongWait(entry); restoreSongEntry(entry); }
    for (const element of [...songTargets]) runs.get(element)?.cancel();
    songTargets.clear();
    songEntries = [];
    songLayer?.remove();
    songLayer = null;
  }
  function prepareSong() {
    cancelSong();
    if (calm() || card.classList.contains('has-overlay') || card.classList.contains('is-resizing') ||
        card.classList.contains('is-dragging') || card.classList.contains('is-circuit-editing') ||
        document.body.classList.contains('widget-auto-hiding')) return false;
    const bounds = card.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'song-transition-layer';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    for (const element of card.querySelectorAll(SONG_PARTS)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' ||
          style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const ghost = clonePainted(element, true);
      for (const [name, value] of Object.entries({
        position: 'absolute', margin: '0', transform: 'none',
        left: rect.left - bounds.left - card.clientLeft + 'px',
        top: rect.top - bounds.top - card.clientTop + 'px',
        width: rect.width + 'px', height: rect.height + 'px'
      })) ghost.style.setProperty(name, value, 'important');
      ghost.style.setProperty('opacity', style.opacity);
      layer.appendChild(ghost);
      songEntries.push({ element, ghost, held: true, started: false, waiting: false,
        opacity: element.style.getPropertyValue('opacity'), priority: element.style.getPropertyPriority('opacity'),
        lyrics: element.matches('.karaoke, .poster-lyric-box'),
        image: element.matches('.cover, .circuit-art') ? element.querySelector('img') : null });
    }
    if (!songEntries.length) return false;
    songLayer = layer;
    songLyricsReady = false;
    card.appendChild(layer);
    for (const entry of songEntries) entry.element.style.setProperty('opacity', '0');
    return true;
  }
  function finishSongEntry(entry) {
    if (entry.started || !songEntries.includes(entry)) return;
    entry.started = true;
    clearSongWait(entry);
    restoreSongEntry(entry);
    const opacity = getComputedStyle(entry.element).opacity;
    songTargets.add(entry.element);
    songTargets.add(entry.ghost);
    // Opacity belongs to the visual shell, never the scrolling lyric transform or native window bounds.
    run(entry.element, [{ opacity: 0 }, { opacity }], 260, false, () => songTargets.delete(entry.element));
    run(entry.ghost, [{ opacity: getComputedStyle(entry.ghost).opacity }, { opacity: 0 }], 220, false, () => {
      songTargets.delete(entry.ghost);
      entry.ghost.remove();
      if (songLayer && !songLayer.childElementCount) { songLayer.remove(); songLayer = null; }
    });
  }
  function commitSong(lyricsReady) {
    songLyricsReady ||= Boolean(lyricsReady);
    if (songFrame || !songEntries.some(entry => !entry.started)) return;
    // The lyric renderer measures and paints its new Canvas on the next frame.
    songFrame = requestAnimationFrame(() => {
      songFrame = requestAnimationFrame(() => {
        songFrame = 0;
        if (calm()) { cancelSong(); return; }
        for (const entry of songEntries) {
          if (entry.started) continue;
          if (entry.lyrics && !songLyricsReady) {
            if (!entry.waiting) {
              entry.waiting = true;
              entry.timer = setTimeout(() => finishSongEntry(entry), 400);
            }
          } else if (entry.image?.getAttribute('src') && !entry.image.complete) {
            if (!entry.waiting) {
              entry.waiting = true;
              entry.loaded = () => commitSong(songLyricsReady);
              entry.image.addEventListener('load', entry.loaded);
              entry.image.addEventListener('error', entry.loaded);
              // A failed or slow cover must never leave the new song permanently hidden.
              entry.timer = setTimeout(() => finishSongEntry(entry), 800);
            }
          } else finishSongEntry(entry);
        }
      });
    });
  }
  function swap(outgoing, incoming) {
    const outOpacity = getComputedStyle(outgoing).opacity;
    const inOpacity = getComputedStyle(incoming).opacity;
    runs.get(outgoing)?.cancel();
    runs.get(incoming)?.cancel();
    outgoing.style.opacity = '0';
    incoming.style.opacity = '1';
    outgoing.setAttribute('aria-hidden', 'true');
    incoming.setAttribute('aria-hidden', 'false');
    run(outgoing, [{ opacity: outOpacity }, { opacity: 0 }], 120);
    run(incoming, [{ opacity: inOpacity }, { opacity: 1 }], 180);
  }
  const onVisibility = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', stop);
  return {
    prepare, commit, swap, stopLayout, prepareSong, commitSong, cancelSong,
    resetLayout() { pending = null; stopLayout(); },
    reveal(element) { run(element, [{ opacity: 0 }, { opacity: 1 }], 180); },
    dispose() {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', stop);
    }
  };
}
