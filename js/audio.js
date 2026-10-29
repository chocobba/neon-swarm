/*
 * NEON SWARM — Web Audio 합성 효과음
 * 오디오 파일 없이 오실레이터와 노이즈로 모든 소리를 만듭니다.
 * 브라우저 정책상 첫 사용자 입력(unlock) 이후에만 소리가 납니다.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MASTER_VOLUME = 0.5;

  // 같은 효과음이 너무 촘촘히 겹치지 않도록 최소 간격(초)
  const MIN_GAP = { shoot: 0.05, hit: 0.03, explode: 0.03, enemyShoot: 0.06, dive: 0.15 };

  const SOUNDS = {
    shoot(s) {
      s.tone({ type: 'square', f0: 1250, f1: 420, dur: 0.09, vol: 0.07 });
    },
    hit(s) {
      s.tone({ type: 'square', f0: 520, f1: 260, dur: 0.07, vol: 0.09 });
      s.noise({ dur: 0.05, vol: 0.12, freq: 4000, freqEnd: 1500 });
    },
    explode(s) {
      s.noise({ dur: 0.3, vol: 0.3, freq: 2600, freqEnd: 200 });
      s.tone({ type: 'triangle', f0: 170, f1: 50, dur: 0.25, vol: 0.18 });
    },
    bigExplode(s) {
      s.noise({ dur: 0.55, vol: 0.4, freq: 3000, freqEnd: 120 });
      s.tone({ type: 'sawtooth', f0: 220, f1: 40, dur: 0.45, vol: 0.12 });
    },
    playerDie(s) {
      s.noise({ dur: 1.0, vol: 0.5, freq: 3200, freqEnd: 80 });
      s.tone({ type: 'sawtooth', f0: 440, f1: 30, dur: 0.95, vol: 0.14 });
    },
    dive(s) {
      s.tone({ type: 'sine', f0: 1400, f1: 340, dur: 0.55, vol: 0.05 });
    },
    enemyShoot(s) {
      s.tone({ type: 'triangle', f0: 620, f1: 240, dur: 0.12, vol: 0.06 });
    },
    powerup(s) {
      s.melody([523, 659, 784, 1047], 0.06, 'square', 0.07);
    },
    extraLife(s) {
      s.melody([784, 988, 1175, 1568, 1175, 1568], 0.08, 'triangle', 0.14);
    },
    levelStart(s) {
      s.melody([392, 523, 659, 784, 659, 988], 0.1, 'square', 0.06);
    },
    levelClear(s) {
      s.melody([523, 659, 784, 1047, 784, 1047, 1319], 0.08, 'triangle', 0.13);
    },
    gameOver(s) {
      s.melody([392, 349, 311, 262, 196], 0.22, 'triangle', 0.15);
    },
    select(s) {
      s.tone({ type: 'square', f0: 660, f1: 990, dur: 0.07, vol: 0.06 });
    },
  };

  class SoundFX {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.noiseBuffer = null;
      this.muted = false;
      this.lastPlayed = Object.create(null);
    }

    /** 첫 사용자 제스처에서 호출: AudioContext 생성/재개 */
    unlock() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        try {
          this.ctx = new AC();
        } catch (e) {
          return;
        }
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.noiseBuffer = this.makeNoiseBuffer();
      }
      if (this.ctx.state === 'suspended') {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    }

    setMuted(muted) {
      this.muted = !!muted;
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.02);
      }
    }

    play(name) {
      if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
      const fn = SOUNDS[name];
      if (!fn) return;
      const now = this.ctx.currentTime;
      const gap = MIN_GAP[name] || 0.02;
      if (this.lastPlayed[name] !== undefined && now - this.lastPlayed[name] < gap) return;
      this.lastPlayed[name] = now;
      try {
        fn(this);
      } catch (e) {
        /* 오디오 오류가 게임을 멈추게 하지 않음 */
      }
    }

    makeNoiseBuffer() {
      const len = Math.floor(this.ctx.sampleRate * 1.0);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }

    envelope(gainNode, start, vol, dur, attack) {
      const g = gainNode.gain;
      g.setValueAtTime(0.0001, start);
      g.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + attack);
      g.exponentialRampToValueAtTime(0.0001, start + dur);
    }

    tone({ type = 'square', f0, f1 = f0, dur, vol = 0.1, delay = 0, attack = 0.005 }) {
      const c = this.ctx;
      const start = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, start);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
      this.envelope(gain, start, vol, dur, attack);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + dur + 0.03);
    }

    noise({ dur, vol = 0.2, freq = 2000, freqEnd = freq, delay = 0 }) {
      const c = this.ctx;
      const start = c.currentTime + delay;
      const src = c.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq, start);
      if (freqEnd !== freq) filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + dur);
      const gain = c.createGain();
      this.envelope(gain, start, vol, dur, 0.004);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      src.start(start);
      src.stop(start + dur + 0.03);
    }

    melody(freqs, step, type, vol) {
      freqs.forEach((f, i) => {
        this.tone({ type, f0: f, dur: step * 1.6, vol, delay: i * step, attack: 0.008 });
      });
    }
  }

  return { SoundFX, SOUND_NAMES: Object.keys(SOUNDS) };
});
