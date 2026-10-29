/*
 * NEON SWARM — 브라우저 연결부
 * 캔버스 크기 조정, 키보드/터치 입력, 메뉴 오버레이, 포커스 관리, 게임 루프를 담당합니다.
 */
(function () {
  'use strict';

  const L = window.NeonLogic;
  const { Game } = window.NeonGame;
  const { SoundFX } = window.NeonAudio;
  const { buildSprites } = window.NeonSprites;

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const screenEl = $('screen');
  const announcer = $('announcer');
  const btnPause = $('btn-pause');
  const btnMute = $('btn-mute');
  const overlays = {
    title: $('overlay-title'),
    paused: $('overlay-pause'),
    gameover: $('overlay-gameover'),
  };

  const MUTE_KEY = 'neonSwarm.muted';
  const START_GUARD_MS = 700; // 게임 오버 직후 연사 키로 바로 재시작되는 것을 방지

  // ── 저장소 (사생활 보호 모드 등에서 localStorage 접근 자체가 실패할 수 있음) ──
  const storage = (() => {
    try {
      const s = window.localStorage;
      const probe = '__neonSwarm_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      return null;
    }
  })();

  const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  const audio = new SoundFX();
  const sprites = buildSprites((w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });

  const game = new Game({
    sprites,
    audio,
    storage,
    reducedMotion: !!(reducedMotionQuery && reducedMotionQuery.matches),
    onEvent: handleGameEvent,
  });

  if (reducedMotionQuery) {
    const onChange = (e) => {
      game.reducedMotion = e.matches;
    };
    if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', onChange);
    else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(onChange);
  }

  // ── 화면 크기 ──
  let view = { sx: 1, sy: 1 };

  function resize() {
    const rect = stage.getBoundingClientRect();
    const avail = { w: Math.max(100, rect.width - 16), h: Math.max(100, rect.height - 8) };
    const scale = Math.min(avail.w / L.WIDTH, avail.h / L.HEIGHT);
    const cssW = Math.floor(L.WIDTH * scale);
    const cssH = Math.floor(L.HEIGHT * scale);
    screenEl.style.width = cssW + 'px';
    screenEl.style.height = cssH + 'px';
    screenEl.style.setProperty('--scale', scale.toFixed(3));
    // 상단 바·터치 버튼 폭을 게임 화면 폭에 맞추기 위한 값
    document.documentElement.style.setProperty('--screen-w', cssW + 'px');
    // 작은 화면에서는 캔버스 HUD를 키워 한글 라벨 가독성 유지 (game.js에서 1~1.3으로 제한)
    game.hudScale = 0.9 / scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    view = { sx: canvas.width / L.WIDTH, sy: canvas.height / L.HEIGHT };
  }

  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();

  // ── 알림(스크린 리더) ──
  let announceTimer = 0;
  function announce(text) {
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => {
      announcer.textContent = text;
    }, 60);
  }

  // ── 입력 ──
  const KEY_ACTIONS = {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    Space: 'fire',
  };
  const heldKeys = new Set();
  const touchHeld = { left: false, right: false, fire: false };

  function syncInput() {
    const kb = { left: false, right: false, fire: false };
    heldKeys.forEach((code) => {
      const a = KEY_ACTIONS[code];
      if (a) kb[a] = true;
    });
    game.input.left = kb.left || touchHeld.left;
    game.input.right = kb.right || touchHeld.right;
    game.input.fire = kb.fire || touchHeld.fire;
  }

  function releaseAllInput() {
    heldKeys.clear();
    touchHeld.left = touchHeld.right = touchHeld.fire = false;
    game.input.pointerX = null;
    dragPointerId = null;
    document.querySelectorAll('.touch-btn.active').forEach((b) => b.classList.remove('active'));
    syncInput();
  }

  let stateChangedAt = 0;

  function isButton(el) {
    return !!(el && el.closest && el.closest('button, a, input, select, textarea'));
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    audio.unlock();
    const code = e.code;
    const state = game.state;
    const onButton = isButton(e.target);

    if (KEY_ACTIONS[code] || code === 'Enter') heldKeys.add(code);

    if (KEY_ACTIONS[code]) {
      if (state === 'playing') {
        e.preventDefault();
        syncInput();
        return;
      }
      // 메뉴에서는 화살표가 페이지를 스크롤하지 않도록 (버튼 위 Space는 기본 동작 = 버튼 누르기)
      if (code !== 'Space' || !onButton) e.preventDefault();
    }

    if (e.repeat) return;

    switch (code) {
      case 'KeyP':
      case 'Escape':
        if (state === 'playing' || state === 'paused') {
          e.preventDefault();
          game.togglePause();
        }
        break;
      case 'KeyM':
        e.preventDefault();
        setMuted(!audio.muted);
        break;
      case 'Enter':
      case 'Space':
        if (onButton) break; // 포커스된 버튼의 기본 동작에 맡김
        if ((state === 'title' || state === 'gameover') && performance.now() - stateChangedAt > START_GUARD_MS) {
          e.preventDefault();
          startGame();
        } else if (state === 'paused' && code === 'Enter') {
          e.preventDefault();
          game.resume();
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    // 플레이 중 Space를 떼는 순간 상단 버튼이 눌리지 않도록
    if (game.state === 'playing' && KEY_ACTIONS[e.code] && isButton(e.target)) e.preventDefault();
    heldKeys.delete(e.code);
    syncInput();
  });

  window.addEventListener('blur', () => {
    releaseAllInput();
    game.pause();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseAllInput();
      game.pause();
    }
  });

  // 터치 버튼: 누르고 있는 동안 동작 (멀티 터치 지원)
  function enableTouchMode(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') document.body.classList.add('touch-mode');
  }

  document.querySelectorAll('.touch-btn').forEach((btn) => {
    const action = btn.dataset.action;
    const press = (e) => {
      e.preventDefault();
      enableTouchMode(e);
      audio.unlock();
      if (btn.setPointerCapture) {
        try {
          btn.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 무시 */
        }
      }
      touchHeld[action] = true;
      btn.classList.add('active');
      syncInput();
      if (game.state === 'title' || game.state === 'gameover') {
        if (action === 'fire' && performance.now() - stateChangedAt > START_GUARD_MS) startGame();
      }
    };
    const release = () => {
      touchHeld[action] = false;
      btn.classList.remove('active');
      syncInput();
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // 키보드/스크린리더의 click 은 무시 (누르고 있기 동작이므로)
    btn.addEventListener('click', (e) => e.preventDefault());
  });

  // 캔버스 드래그: 손가락 위치를 따라 이동하며 자동 발사
  let dragPointerId = null;

  function toLogicalX(clientX) {
    const r = canvas.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * L.WIDTH;
  }

  canvas.addEventListener('pointerdown', (e) => {
    enableTouchMode(e);
    audio.unlock();
    if (game.state !== 'playing') return;
    e.preventDefault();
    dragPointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 무시 */
    }
    game.input.pointerX = toLogicalX(e.clientX);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragPointerId) return;
    game.input.pointerX = toLogicalX(e.clientX);
  });

  const endDrag = (e) => {
    if (e.pointerId !== dragPointerId) return;
    dragPointerId = null;
    game.input.pointerX = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  document.addEventListener('pointerdown', () => audio.unlock(), { passive: true });

  // ── 버튼 ──
  function startGame() {
    audio.unlock();
    audio.play('select');
    game.start();
  }

  function setMuted(muted) {
    audio.setMuted(muted);
    btnMute.setAttribute('aria-pressed', String(muted));
    btnMute.title = muted ? '소리 꺼짐 (M)' : '소리 켜짐 (M)';
    try {
      if (storage) storage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch (e) {
      /* 무시 */
    }
    announce(muted ? '소리를 껐습니다' : '소리를 켰습니다');
  }

  $('btn-start').addEventListener('click', startGame);
  $('btn-retry').addEventListener('click', startGame);
  $('btn-resume').addEventListener('click', () => game.resume());
  $('btn-quit').addEventListener('click', () => game.quitToTitle());
  $('btn-title').addEventListener('click', () => game.quitToTitle());

  btnPause.addEventListener('click', () => {
    audio.unlock();
    game.togglePause();
  });

  btnMute.addEventListener('click', () => {
    audio.unlock();
    setMuted(!audio.muted);
    // 플레이 중이면 포커스를 게임으로 돌려 Space가 버튼을 다시 누르지 않게 함
    if (game.state === 'playing') canvas.focus({ preventScroll: true });
  });

  // ── 상태별 UI ──
  let focusToken = 0;

  /** 게임 키를 모두 놓고 최소 시간이 지난 뒤 포커스를 이동 (누르고 있던 Space가 버튼을 누르는 사고 방지) */
  function focusWhenReady(el, minDelay) {
    const token = ++focusToken;
    const t0 = performance.now();
    const attempt = () => {
      if (token !== focusToken || el.closest('[hidden]')) return;
      if (performance.now() - t0 < (minDelay || 0) || heldKeys.size > 0) {
        setTimeout(attempt, 50);
        return;
      }
      el.focus({ preventScroll: true });
    };
    attempt();
  }

  function showState(info) {
    const state = info.state;
    stateChangedAt = performance.now();
    document.body.dataset.state = state;
    overlays.title.hidden = state !== 'title';
    overlays.paused.hidden = state !== 'paused';
    overlays.gameover.hidden = state !== 'gameover';

    const pausable = state === 'playing' || state === 'paused';
    btnPause.disabled = !pausable;
    btnPause.setAttribute('aria-pressed', String(state === 'paused'));

    switch (state) {
      case 'title':
        $('title-high').textContent = L.formatScore(game.highScore);
        focusWhenReady($('btn-start'), 0);
        announce('타이틀 화면. 게임 시작 버튼을 누르세요.');
        break;
      case 'playing':
        focusToken++;
        canvas.focus({ preventScroll: true });
        break;
      case 'paused':
        releaseAllInput();
        focusWhenReady($('btn-resume'), 0);
        announce('일시정지됨');
        break;
      case 'gameover': {
        $('go-score').textContent = info.score.toLocaleString('ko-KR');
        $('go-high').textContent = info.highScore.toLocaleString('ko-KR');
        $('go-level').textContent = String(info.level);
        $('go-kills').textContent = String(info.kills);
        $('go-accuracy').textContent = info.accuracy + '%';
        $('new-record').hidden = !info.isNewRecord;
        focusWhenReady($('btn-retry'), START_GUARD_MS);
        announce(
          `게임 오버. 점수 ${info.score}점, 스테이지 ${info.level}.` + (info.isNewRecord ? ' 신기록입니다!' : '')
        );
        break;
      }
      default:
        break;
    }
  }

  function handleGameEvent(type, data) {
    if (type === 'state') showState(data);
    else if (type === 'announce') announce(data);
  }

  // ── 초기화 ──
  let initialMuted = false;
  try {
    initialMuted = !!storage && storage.getItem(MUTE_KEY) === '1';
  } catch (e) {
    initialMuted = false;
  }
  audio.setMuted(initialMuted);
  btnMute.setAttribute('aria-pressed', String(initialMuted));
  btnMute.title = initialMuted ? '소리 꺼짐 (M)' : '소리 켜짐 (M)';
  showState({ state: 'title' });

  // ── 게임 루프 (고정 시간 간격) ──
  const STEP = 1 / 120;
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 24) {
      game.update(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps >= 24) acc = 0;
    ctx.setTransform(view.sx, 0, 0, view.sy, 0, 0);
    ctx.imageSmoothingEnabled = true;
    game.render(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 자동화 테스트·디버깅용 핸들
  window.__neonSwarm = { game, audio };
})();
