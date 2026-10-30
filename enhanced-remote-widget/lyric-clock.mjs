// Slew small corrections at 0.8–1.2x instead of stepping backward or freezing.
export function createLyricClockGuard() {
  let previous = null;
  let previousNow = null;
  return {
    reset() { previous = null; previousNow = null; },
    read(time, advancing, now = performance.now()) {
      const elapsed = previousNow === null ? 0 : Math.max(0, (now - previousNow) / 1000);
      previousNow = now;
      if (previous === null || !advancing || elapsed > 0.75) {
        previous = time;
        return time;
      }
      const predicted = previous + elapsed;
      const error = time - predicted;
      if (Math.abs(error) > 0.5) {
        previous = time;
        return time;
      }
      const limit = elapsed * 0.2;
      const correction = Math.max(-limit, Math.min(limit, error * (1 - Math.exp(-elapsed / 0.6))));
      previous = predicted + correction;
      return previous;
    }
  };
}
