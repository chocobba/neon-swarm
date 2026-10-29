'use strict';
/* 테스트용 가짜 캔버스/저장소/오디오 */

/** 모든 메서드 호출을 받아 주는 2D 컨텍스트 스텁. 호출 횟수를 기록하고 숫자 인자의 유효성을 검사합니다. */
function makeStubContext(log) {
  const state = {};
  const gradient = { addColorStop() {} };
  const handler = {
    get(_t, prop) {
      if (prop in state) return state[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'measureText') return (s) => ({ width: String(s).length * 8 });
      return (...args) => {
        if (log) {
          log.calls[prop] = (log.calls[prop] || 0) + 1;
          for (const a of args) {
            if (typeof a === 'number' && !Number.isFinite(a)) log.badArgs.push({ method: prop, args });
          }
        }
      };
    },
    set(_t, prop, value) {
      state[prop] = value;
      return true;
    },
  };
  return new Proxy({}, handler);
}

function makeStubCanvasFactory(log) {
  return (w, h) => ({ width: w, height: h, getContext: () => makeStubContext(log) });
}

function makeMemoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

function makeAudioSpy() {
  const played = [];
  return { played, play: (name) => played.push(name) };
}

module.exports = { makeStubContext, makeStubCanvasFactory, makeMemoryStorage, makeAudioSpy };
