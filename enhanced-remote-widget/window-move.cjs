'use strict';

// Native window dimensions are in DIP, not renderer CSS pixels.
module.exports = function createWindowMover(onError = () => {}) {
  let size = null;
  // Electron converts positions to signed 32-bit integers. Validate again
  // after edge snapping, which can replace the renderer's rounded coordinates.
  const coordinate = value => {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return rounded >= -2147483648 && rounded <= 2147483647 ? rounded : null;
  };
  return function move(window, x, y, begin, end) {
    x = coordinate(x);
    y = coordinate(y);
    if (x === null || y === null || !window || window.isDestroyed?.()) {
      size = null;
      return false;
    }
    try {
      if (begin || !size) size = window.getSize();
      window.setPosition(x, y, false);
      const actual = window.getSize();
      if (actual[0] !== size[0] || actual[1] !== size[1]) {
        window.setSize(size[0], size[1], false);
      }
      if (end) size = null;
      return true;
    } catch (error) {
      size = null;
      onError(error, { x, y });
      return false;
    }
  };
};
