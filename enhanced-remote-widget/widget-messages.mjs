const messages = Object.freeze({
  en: Object.freeze({
    connecting: 'Connecting to Folia…',
    unavailable: 'Folia playback is temporarily unavailable. Reconnecting…',
    stale: 'Waiting for Folia to resume state synchronization…',
    preview: 'Layout preview · Playback controls require Folia.',
    disableClickThrough: 'Turn off click-through',
    clickThroughUnavailable: 'Click-through could not start. Check the Folia mod log.'
  }),
  'zh-CN': Object.freeze({
    connecting: '正在连接 Folia…',
    unavailable: '宿主播放暂不可用，正在等待恢复…',
    stale: '宿主状态同步已中断，正在等待恢复…',
    preview: '布局预览 · 播放控制需在 Folia 内使用',
    disableClickThrough: '关闭点击穿透',
    clickThroughUnavailable: '无法开启点击穿透，请查看 Folia 模组日志。'
  })
});

export function interactionMessage(key, language = 'en') {
  const locale = language.toLowerCase().startsWith('zh') ? messages['zh-CN'] : messages.en;
  return locale[key] || messages.en[key] || '';
}

export function connectionMessage(status, language = 'en') {
  if (status === 'connected') return '';
  const locale = language.toLowerCase().startsWith('zh') ? messages['zh-CN'] : messages.en;
  return locale[status] || messages.en.connecting;
}
