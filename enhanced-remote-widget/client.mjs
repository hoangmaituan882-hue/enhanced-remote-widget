// remote-control-widget/client.mjs
// Folium 客户端入口：捕获歌曲、解析专辑与发布时间、提取完整逐词歌词数据并响应悬浮窗操作
'use strict';
import { createVolumeController } from './client-volume.mjs';
import { getLineTranslation } from './lyric-translation.mjs';

const normalizeMetadataText = (text) => String(text || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function matchesSongText(song, candidate) {
  const title = normalizeMetadataText(song?.title);
  if (!title || title !== normalizeMetadataText(candidate?.title)) return false;
  if (song.artist && normalizeMetadataText(song.artist) !== normalizeMetadataText(candidate.artist)) return false;
  return !song.album || !candidate.album || normalizeMetadataText(song.album) === normalizeMetadataText(candidate.album);
}

function matchesHostSong(song, current) {
  if (!song || !current) return false;
  const sourceRef = current.sourceRef;
  const source = sourceRef?.kind === 'online' ? sourceRef.providerId : sourceRef?.kind || current.source;
  const id = current.id ?? sourceRef?.mediaId;
  if (song.source && song.source !== source) return false;
  if (song.id != null && String(song.id) !== String(id ?? '')) return false;
  return matchesSongText(song, {
    title: current.title || current.name,
    artist: current.artist || (current.artists || []).map((artist) => artist?.name).filter(Boolean).join(' / '),
    album: current.album?.name || (typeof current.album === 'string' ? current.album : '')
  });
}

export default function activate(folium) {
  // 导出窗口不提供播放、网络和 RPC 服务。
  if (folium.env?.context === 'export') return () => {};
  let isDisposed = false;
  const volume = createVolumeController(folium, () => !isDisposed);
  const metadataCache = new Map();
  let currentLyricsData = null;
  let lyricsSongKey = null;
  let activeSongKey = '';
  let playbackReady = false;
  let actionLoopStarted = false;
  let songGeneration = 0;
  let snapshotPending = false;
  let nextSnapshotAt = 0;
  let lyricStage = null;
  const stageDisposers = new Set();

  function readPlaybackState() {
    try {
      return folium.playback.getState();
    } catch (error) {
      // 壁纸切换会重建主窗口；客户端激活时播放桥接可能尚未挂载。
      // 返回未就绪，不发送空状态，后续同步会自动恢复。
      if (error?.message !== 'playback-unavailable-in-main-context') throw error;
      playbackReady = false;
      return null;
    }
  }

  function getSongKey(song) {
    if (!song) return '';
    return song.ref || JSON.stringify([song.source || '', song.id || '', song.title || '', song.artist || '', song.album || '']);
  }

  function updateActiveSong(song) {
    const key = getSongKey(song);
    if (key === activeSongKey) return;
    activeSongKey = key;
    songGeneration++;
    currentLyricsData = null;
    lyricsSongKey = null;
    nextSnapshotAt = 0;
  }

  function getMatchingLyricStage(song) {
    const ctx = lyricStage?.ctx;
    // Stage contexts belong to one song and can briefly outlive a song change.
    // Their public song DTO carries text, not the session ref.
    if (!ctx) return null;
    const identity = JSON.stringify([ctx.seed ?? '', ctx.song?.title || '', ctx.song?.artist || '', ctx.song?.album || '']);
    // Current hosts remount per song; also tolerate a future mutable context,
    // but never rebind an unchanged, old context to a new session ref.
    if ((lyricStage.songKey && lyricStage.songKey !== getSongKey(song) && lyricStage.identity === identity) ||
        (ctx.seed != null && song?.id != null && String(ctx.seed) !== String(song.id)) ||
        !matchesSongText(song, ctx.song)) return null;
    lyricStage.songKey = getSongKey(song);
    lyricStage.identity = identity;
    return ctx;
  }

  function readLyricClock(state) {
    const ctx = getMatchingLyricStage(state.song);
    if (ctx) {
      try {
        const position = ctx.currentTime.get();
        if (Number.isFinite(position)) {
          return { lyricPosition: position, lyricRate: ctx.isPaused() ? 0 : 1 };
        }
      } catch {}
    }
    return { lyricPosition: null, lyricRate: state.state === 'playing' ? 1 : 0 };
  }

  function pushClockState(state) {
    if (isDisposed || !state) return;
    const clock = readLyricClock(state);
    folium.rpc.call('syncState', {
      songKey: getSongKey(state.song),
      position: state.position,
      duration: state.duration,
      state: state.state,
      ...clock,
      currentLyric: getActiveLyricText(clock.lyricPosition ?? state.position)
    }).catch(() => {});
  }

  function cacheMetadata(key, value) {
    if (isDisposed) return;
    metadataCache.delete(key);
    metadataCache.set(key, value);
    while (metadataCache.size > 128) metadataCache.delete(metadataCache.keys().next().value);
  }

  // 1. 深度提取歌词数据结构（含逐词与逐字时间戳）
  function extractLyrics(source) {
    if (!source) return null;
    const lines = source.lines || (Array.isArray(source) ? source : null);
    if (!Array.isArray(lines) || lines.length === 0) return null;

    return {
      isWordByWord: Boolean(source.isWordByWord),
      lines: lines.filter((line) => line && Number.isFinite(line.startTime)).map((line) => ({
        startTime: line.startTime,
        endTime: Number.isFinite(line.endTime) ? line.endTime : line.startTime + 6,
        fullText: String(line.fullText || ''),
        translation: getLineTranslation(line),
        renderHints: Number.isFinite(line.renderHints?.renderEndTime)
          ? { renderEndTime: line.renderHints.renderEndTime } : undefined,
        words: Array.isArray(line.words)
          ? line.words.filter((w) => w && Number.isFinite(w.startTime)).map((w) => ({
              text: String(w.text || ''),
              startTime: w.startTime,
              endTime: Number.isFinite(w.endTime) ? w.endTime : w.startTime,
            }))
          : [],
      })),
    };
  }

  function getLatestLyrics() {
    return lyricsSongKey === activeSongKey ? currentLyricsData : null;
  }

  // 公开事件是歌词的唯一实时来源；快照只补齐错过的事件，不覆盖已收到的数据。
  async function recoverLyrics() {
    if (isDisposed || !playbackReady || !activeSongKey || lyricsSongKey === activeSongKey || snapshotPending || Date.now() < nextSnapshotAt) return;
    const key = activeSongKey;
    const generation = songGeneration;
    snapshotPending = true;
    nextSnapshotAt = Date.now() + 2000;
    try {
      const snapshot = await folium.rpc.call('getPlaybackSnapshot');
      if (isDisposed) return;
      const state = readPlaybackState();
      if (!state || generation !== songGeneration || key !== getSongKey(state.song) ||
          lyricsSongKey === key || !snapshot || getSongKey(snapshot.song) !== key) return;
      const lyrics = extractLyrics({ lines: snapshot.lines });
      // 空快照可能只是宿主尚未同步，不把它记成已就绪，后续继续补齐。
      if (!lyrics?.lines.length) return;
      currentLyricsData = lyrics;
      lyricsSongKey = key;
      pushCurrentState(true);
    } catch (e) {
      // 下一轮时间同步会重试；停用或切歌后不会写回旧歌词。
    } finally {
      snapshotPending = false;
    }
  }

  // 2. 计算当前播放时间对应的正在演唱的文本行（作为降级显示）
  function getActiveLyricText(timeSeconds) {
    const data = getLatestLyrics();
    if (!data || !data.lines || data.lines.length === 0) return '';
    const lines = data.lines;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (timeSeconds >= line.startTime) {
        const end = line.renderHints?.renderEndTime ?? line.endTime ?? (line.startTime + 6);
        if (timeSeconds <= end) {
          return line.fullText || '';
        }
      }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      if (timeSeconds >= lines[i].startTime) {
        return lines[i].fullText || '';
      }
    }

    return lines[0]?.fullText || '';
  }

  // 3. 同步读取宿主元数据，缺失信息在后台补齐。
  const inFlightEnrichments = new Set();

  function resolveSongMetadataSync(song) {
    if (!song) {
      return {
        title: '未在播放',
        artist: '等待播放音乐',
        album: '未知专辑',
        publishTime: '未知发行时间',
        coverUrl: ''
      };
    }

    const title = song.title || '';
    const artist = song.artist || '';
    let album = song.album || '';
    const cacheKey = getSongKey(song);
    const cached = metadataCache.get(cacheKey);
    if (!album && cached?.album !== '未知专辑') album = cached?.album || '';
    let publishTime = cached?.publishTime !== '未知发行时间' ? cached?.publishTime || '' : '';
    let coverUrl = cached?.coverUrl || '';

    // 途径 A：从宿主内部 Zustand Store（folium.internals）同步直接提取
    try {
      if (folium.internals && folium.internals.stores && folium.internals.stores.playback) {
        const storeState = folium.internals.stores.playback.getState();
        const current = storeState.currentSong;
        if (matchesHostSong(song, current)) {
          if (!album && current.album && current.album.name) {
            album = current.album.name;
          }
          if (current.album && current.album.coverUrl) {
            coverUrl = current.album.coverUrl;
          }
          const rawTime = current.album?.publishedAt || current.publishTime;
          if (rawTime) {
            const d = new Date(rawTime);
            if (!isNaN(d.getTime())) {
              publishTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
          }
        }
      }
    } catch (e) {}

    // The public stage cover includes local/cached assets and transition covers.
    // Prefer that authoritative URL over external metadata search results.
    try {
      const stageCover = getMatchingLyricStage(song)?.getCoverUrl();
      if (typeof stageCover === 'string' && stageCover) coverUrl = stageCover;
    } catch {}

    const partial = {
      title,
      artist,
      album: album || '未知专辑',
      publishTime: publishTime || '未知发行时间',
      coverUrl: coverUrl || ''
    };

    // 若发布时间缺失，启动非阻塞后台丰富化任务，绝不拖慢用户界面与播放响应
    cacheMetadata(cacheKey, partial);
    if (!cached && !publishTime && (title || song.id)) {
      enrichMetadataInBackground(song, cacheKey, partial);
    }

    return partial;
  }

  // 后台静默丰富化专辑与发行时间（防抖并发且超时保护）
  async function enrichMetadataInBackground(song, cacheKey, fallback) {
    if (isDisposed || inFlightEnrichments.has(cacheKey)) return;
    inFlightEnrichments.add(cacheKey);

    try {
      let album = fallback.album !== '未知专辑' ? fallback.album : '';
      let coverUrl = fallback.coverUrl;
      let publishTime = '';

      // Provider IDs are only meaningful inside their provider's namespace.
      if (song.source === 'netease' && song.id && /^\d+$/.test(song.id)) {
        try {
          const res = await folium.net.fetch(`https://music.163.com/api/song/detail/?id=${song.id}&ids=[${song.id}]`, { timeoutMs: 2500 });
          if (isDisposed) return;
          if (res.ok) {
            const json = await res.json();
            const s = json?.songs?.[0];
            if (s && String(s.id) === String(song.id) && matchesSongText(song, {
              title: s.name,
              artist: (s.artists || []).map((artist) => artist?.name).filter(Boolean).join(' / '),
              album: s.album?.name
            })) {
              if (!album && s.album?.name) album = s.album.name;
              if (!coverUrl && s.album?.picUrl) coverUrl = s.album.picUrl;
              const ts = s.album?.publishTime || s.publishTime;
              if (ts) {
                const d = new Date(ts);
                if (!isNaN(d.getTime())) publishTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              }
            }
          }
        } catch (e) {}
      }

      // B-2: 通过 iTunes Search API 检索公开发行日期与高清封面
      if (!isDisposed && !publishTime && fallback.title) {
        try {
          const query = encodeURIComponent(`${fallback.title} ${fallback.artist}`.trim());
          const itunesRes = await folium.net.fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=5`, { timeoutMs: 2500 });
          if (isDisposed) return;
          if (itunesRes.ok) {
            const itunesData = await itunesRes.json();
            const normalize = normalizeMetadataText;
            const artists = fallback.artist.split(/\s*[/、,&]\s*/).filter(Boolean).map(normalize);
            const item = Array.isArray(itunesData.results) ? itunesData.results.find((result) =>
              normalize(result.trackName) === normalize(fallback.title) &&
              Boolean(fallback.artist) &&
              (normalize(result.artistName) === normalize(fallback.artist) || artists.includes(normalize(result.artistName))) &&
              (!song.album || normalize(result.collectionName) === normalize(song.album))) : null;
            if (item) {
              if (!album && item.collectionName) album = item.collectionName;
              if (!coverUrl && item.artworkUrl100) coverUrl = item.artworkUrl100.replace('100x100bb', '600x600bb');
              if (item.releaseDate) {
                publishTime = item.releaseDate.split('T')[0];
              }
            }
          }
        } catch (e) {}
      }

      const latest = metadataCache.get(cacheKey);
      const enriched = {
        title: fallback.title,
        artist: fallback.artist,
        album: (latest?.album !== '未知专辑' && latest?.album) || album || fallback.album || '未知专辑',
        publishTime: (latest?.publishTime !== '未知发行时间' && latest?.publishTime) || publishTime || fallback.publishTime || '未知发行时间',
        coverUrl: latest?.coverUrl || coverUrl || fallback.coverUrl || ''
      };

      if (isDisposed) return;
      cacheMetadata(cacheKey, enriched);

      // 若成功解析出更有价值的信息，静默补推一次轻量状态更新
      if (activeSongKey === cacheKey && (enriched.publishTime !== fallback.publishTime || enriched.album !== fallback.album || enriched.coverUrl !== fallback.coverUrl)) {
        pushCurrentState(false);
      }
    } catch (err) {
      cacheMetadata(cacheKey, metadataCache.get(cacheKey) || fallback);
    } finally {
      inFlightEnrichments.delete(cacheKey);
    }
  }

  // 4. 将当前播放器状态推送到 Node 主进程（智能判断切歌才携带全量歌词树，避免 IPC 拥堵）
  let lastPushedSongKey = '';

  async function pushCurrentState(forceIncludeLyrics = false) {
    if (isDisposed) return;
    try {
      const state = readPlaybackState();
      if (!state) return;
      updateActiveSong(state.song);
      const metadata = resolveSongMetadataSync(state.song);
      const lyricClock = readLyricClock(state);
      const songKey = getSongKey(state.song);
      const isSongChanged = songKey !== lastPushedSongKey;
      if (isSongChanged) {
        lastPushedSongKey = songKey;
      }

      const payload = {
        songKey,
        // ref 只在当前宿主会话有效；歌词偏移使用可跨重启的歌曲标识。
        songPersistentKey: state.song ? JSON.stringify(state.song.id
          ? [state.song.source || '', state.song.id]
          : [state.song.source || '', state.song.title || '', state.song.artist || '', state.song.album || '']) : '',
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        publishTime: metadata.publishTime,
        coverUrl: metadata.coverUrl,
        position: state.position,
        duration: state.duration,
        state: state.state,
        ...lyricClock,
        liked: Boolean(state.liked),
        canLike: state.canLike !== false && Boolean(state.song),
        currentLyric: getActiveLyricText(lyricClock.lyricPosition ?? state.position)
      };

      // 仅在歌曲切换或歌词显式更新时发送完整歌词。
      if (isSongChanged || forceIncludeLyrics) {
        payload.lyrics = getLatestLyrics();
      }

      await folium.rpc.call('syncState', payload);
      recoverLyrics();
    } catch (e) {
      folium.log.error('推送状态至悬浮小组件出错: ' + e.message);
    }
  }

  // 5. 按顺序执行来自悬浮小组件的控制指令。
  async function startActionLoop() {
    while (!isDisposed) {
      try {
        if (!readPlaybackState()) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        let actions = null;
        try {
          actions = await folium.rpc.call('pollActions');
        } catch (e) {
          const single = await folium.rpc.call('pollAction');
          actions = single ? [single] : [];
        }

        if (isDisposed) break;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        if (list.length === 0) {
          // 宿主重载期间可能立即返回空队列，避免无等待的 RPC 循环占满线程。
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        let needsStatePush = false;
        for (const action of list) {
          if (!action || !action.action) continue;
          // 长轮询返回期间桥接也可能卸载；保留已取出的操作，等它恢复后再执行。
          while (!isDisposed && !readPlaybackState()) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (isDisposed) break;
          try {
            switch (action.action) {
              case 'play':
                folium.playback.play();
                needsStatePush = true;
                break;
              case 'pause':
                folium.playback.pause();
                needsStatePush = true;
                break;
              case 'toggle':
                folium.playback.toggle();
                needsStatePush = true;
                break;
              case 'next':
                folium.playback.next();
                needsStatePush = true;
                break;
              case 'previous':
                folium.playback.previous();
                needsStatePush = true;
                break;
              case 'seek':
                if (Number.isFinite(action.value)) {
                  const duration = folium.playback.getState().duration;
                  folium.playback.seek(Math.max(0, duration > 0 ? Math.min(duration, action.value) : action.value));
                  needsStatePush = true;
                }
                break;
              case 'toggleLike':
                if (typeof folium.playback.toggleLike === 'function') folium.playback.toggleLike();
                needsStatePush = true;
                break;
              case 'shuffle':
                if (typeof folium.playback.shuffleQueue === 'function') folium.playback.shuffleQueue();
                needsStatePush = true;
                break;
              case 'volumeDelta': {
                try {
                  const next = await volume.adjust(action.value);
                  if (!isDisposed && next !== null) {
                    await folium.rpc.call('syncState', { wheelFeedback: `音量 ${Math.round(next * 100)}%` });
                  }
                } catch (error) {
                  if (!isDisposed) {
                    await folium.rpc.call('syncState', { wheelFeedback: '当前宿主暂不支持音量调整' });
                    folium.log.warn('调整音量失败: ' + error.message);
                  }
                }
                break;
              }
            }
          } catch (actionErr) {
            folium.log.warn('执行播放控制命令失败: ' + actionErr.message);
          }
        }

        if (needsStatePush) {
          pushCurrentState(false);
        }
      } catch (err) {
        if (isDisposed) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // 6. 事件监听：歌词就绪、切歌、播放/暂停、跳转
  const unsubLyrics = folium.events.on('lyrics.loaded', (event) => {
    if (isDisposed) return;
    const state = readPlaybackState();
    if (!state) return;
    updateActiveSong(state.song);
    if (event && Object.prototype.hasOwnProperty.call(event, 'song') && getSongKey(event.song) !== activeSongKey) return;
    const lines = Array.isArray(event?.lines) ? event.lines : event?.lyrics?.lines;
    if (!Array.isArray(lines)) return;
    currentLyricsData = extractLyrics({ lines });
    lyricsSongKey = activeSongKey;
    pushCurrentState(true);
  });
  const unsubSong = folium.events.on('playback.songChanged', () => pushCurrentState());
  const unsubState = folium.events.on('playback.stateChanged', () => pushCurrentState());
  const unsubSeek = folium.events.on('playback.seeked', () => pushCurrentState());
  const unsubLike = typeof folium.playback.toggleLike === 'function'
    ? folium.events.on('playback.likeChanged', () => pushCurrentState()) : () => {};

  // 激活必须同步返回，让宿主继续挂载播放器；每 300ms 检查并恢复桥接。
  function syncPlayback() {
    if (isDisposed) return;
    const state = readPlaybackState();
    if (!state) return;
    if (!actionLoopStarted) {
      actionLoopStarted = true;
      startActionLoop();
    }
    if (!playbackReady || getSongKey(state.song) !== activeSongKey) {
      playbackReady = true;
      pushCurrentState(true);
    } else if (state.state === 'playing' || lyricStage) {
      pushClockState(state);
    }
    recoverLyrics();
  }
  const timer = setInterval(syncPlayback, 300);

  // Public stage contexts expose the host's lyric clock, including its offsets
  // and lyrics-only sources. The layer paints nothing and captures no input.
  let lyricStageHandle = null;
  if (folium.registries.stageLayers?.register) {
    lyricStageHandle = folium.registries.stageLayers.register({
      id: 'widget-lyric-clock',
      // The app overlay stays mounted on Folia 0.7.9's home/player/Lattice views.
      slot: 'app.overlay',
      interactive: false,
      mount: (_container, ctx) => {
        if (isDisposed || ctx.staticMode || ctx.isPreview) return () => {};
        const stage = { ctx };
        lyricStage = stage;
        const unsubscribe = ctx.subscribe(() => {
          if (!isDisposed && lyricStage === stage) pushCurrentState(false);
        });
        const release = () => {
          if (!stageDisposers.delete(release)) return;
          unsubscribe();
          if (lyricStage === stage) {
            lyricStage = null;
            if (!isDisposed) pushCurrentState(false);
          }
        };
        stageDisposers.add(release);
        pushCurrentState(false);
        return release;
      }
    });
  }

  // 7. 在 Folia 播放条右侧增加【悬浮小组件】快捷打开按钮
  folium.registries.controlButtons.register({
    id: 'toggle-enhanced-widget-btn',
    slot: 'progress.trailing',
    order: 480,
    mount: (container) => {
      container.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;';
      const btn = document.createElement('button');
      btn.style.cssText = 'background: transparent; border: none; outline: none; cursor: pointer; color: inherit; opacity: 0.75; display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 6px; transition: opacity 0.15s ease, transform 0.15s ease;';
      btn.title = '打开/关闭增强版桌面悬浮小组件';
      
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <rect x="11" y="9" width="8" height="6" rx="1" ry="1" fill="currentColor"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
      `;

      btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1.1)'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.75'; btn.style.transform = 'scale(1)'; });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        folium.rpc.call('toggleWidget').catch(() => {});
      });

      container.appendChild(btn);
      return () => {
        btn.remove();
      };
    }
  });

  // 8. 在命令面板中注册命令
  folium.registries.commands.register({
    id: 'toggle-widget-cmd',
    label: { 'zh-CN': '切换增强版桌面悬浮小组件', en: 'Toggle Enhanced Floating Widget' },
    keywords: ['widget', '悬浮', '小组件', '小窗', '桌面歌词', 'remote'],
    run: async () => {
      return folium.rpc.call('toggleWidget');
    }
  });

  // 启动主轮询与初次状态推送
  syncPlayback();

  // 9. 释放清理
  return () => {
    isDisposed = true;
    clearInterval(timer);
    metadataCache.clear();
    inFlightEnrichments.clear();
    currentLyricsData = null;
    for (const release of [...stageDisposers]) release();
    lyricStage = null;
    lyricStageHandle?.unregister();
    unsubLyrics();
    unsubSong();
    unsubState();
    unsubSeek();
    unsubLike();
  };
}
