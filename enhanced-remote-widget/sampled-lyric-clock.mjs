// A hidden host can keep returning the last animation-frame sample. Polling
// that same value again must not give it a new timestamp.
export function createSampledLyricClock() {
  let sample = null;
  return {
    reset() { sample = null; },
    read(position, rate, identity, now = performance.now()) {
      if (!sample || sample.identity !== identity || sample.rate !== rate || sample.position !== position) {
        sample = { position, rate, identity, at: now };
      }
      return position + (rate ? Math.max(0, now - sample.at) / 1000 : 0);
    }
  };
}
