/*
 * NEON SWARM — 순수 게임 로직 / 데이터
 * DOM에 의존하지 않으므로 브라우저(전역 NeonLogic)와 Node 테스트(require) 모두에서 사용됩니다.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 논리 해상도 (캔버스는 이 좌표계를 화면 크기에 맞게 확대/축소합니다)
  const WIDTH = 480;
  const HEIGHT = 640;
  const PLAYER_Y = HEIGHT - 70;

  const GRID_COLS = 10;
  const SLOT_SPACING_X = 36;
  const SLOT_SPACING_Y = 32;
  const FORMATION_TOP = 96;

  const ENEMY_TYPES = {
    drone: { name: '드론', hp: 1, score: 50, diveScore: 100, w: 22, h: 16 },
    stinger: { name: '스팅어', hp: 1, score: 80, diveScore: 160, w: 22, h: 18 },
    warden: { name: '워든', hp: 2, score: 150, diveScore: 400, w: 26, h: 20 },
  };
  const TYPE_BY_CHAR = { D: 'drone', S: 'stinger', W: 'warden' };

  // 편대 배치 (W=워든, S=스팅어, D=드론, .=빈칸). 모두 이 게임을 위한 독자적인 배치입니다.
  const FORMATIONS = [
    {
      id: 'bulwark',
      name: '방벽',
      rows: [
        '...WWWW...',
        '.SSSSSSSS.',
        '.SSSSSSSS.',
        'DDDDDDDDDD',
        'DDDDDDDDDD',
      ],
    },
    {
      id: 'arrowhead',
      name: '화살촉',
      rows: [
        'WW......WW',
        '.SSS..SSS.',
        '..SSSSSS..',
        'D..DDDD..D',
        'DDD.DD.DDD',
      ],
    },
    {
      id: 'prism',
      name: '프리즘',
      rows: [
        '....WW....',
        '..SSSSSS..',
        '.SSWSSWSS.',
        '.DDDDDDDD.',
        '...DDDD...',
      ],
    },
    {
      id: 'twin',
      name: '쌍둥이 성단',
      rows: [
        '.WW....WW.',
        'SSSS..SSSS',
        'SSSS..SSSS',
        'DDDD..DDDD',
        '.DDD..DDD.',
      ],
    },
  ];

  // 입장 경로 (왼쪽 기준, 홀수 그룹은 좌우 반전)
  const ENTRY_PATTERNS = [
    // 위에서 급강하한 뒤 아래쪽에서 크게 돌아 편대로 복귀
    [{ x: 220, y: -24 }, { x: 150, y: 260 }, { x: 10, y: 430 }, { x: 120, y: 450 }],
    // 측면 하단에서 솟구쳐 오르며 진입
    [{ x: -24, y: 540 }, { x: 170, y: 500 }, { x: 320, y: 320 }, { x: 220, y: 250 }],
  ];

  const ENTRY_GROUP_SIZE = 8;
  const EXTRA_LIFE_FIRST = 10000;
  const EXTRA_LIFE_EVERY = 30000;
  const MAX_SCORE = 99999999;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** 3차 베지어 곡선 위의 점 */
  function bezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  /** 중심 좌표 기준 사각형 충돌 판정 ({x, y, w, h}) */
  function overlaps(a, b) {
    return Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
  }

  /** 시드 기반 난수 생성기 (mulberry32) — 테스트 재현용 */
  function makeRng(seed) {
    let s = seed >>> 0;
    return function rng() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 스테이지별 난이도 설정. 15스테이지에서 대부분의 수치가 최고치에 도달합니다. */
  function levelConfig(level) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    const t = Math.min(1, (lv - 1) / 14);
    const cycle = Math.floor((lv - 1) / FORMATIONS.length);
    return {
      level: lv,
      formation: FORMATIONS[(lv - 1) % FORMATIONS.length],
      entrySpeed: 1 + 0.45 * t,
      swaySpeed: 0.9 + 0.7 * t,
      diveInterval: lerp(3.0, 0.85, t),
      maxDivers: Math.min(7, 1 + Math.floor(lv / 2)),
      diveSpeed: lerp(170, 290, t),
      zigzagChance: lv < 3 ? 0 : Math.min(0.6, 0.15 * (lv - 2)),
      shotsPerDive: lv < 3 ? 1 : lv < 7 ? 2 : 3,
      fireChance: lerp(0.35, 0.85, t),
      formationFireInterval: lerp(4.5, 1.1, t),
      enemyBulletSpeed: lerp(180, 310, t),
      maxEnemyBullets: Math.round(lerp(4, 12, t)),
      escortChance: lv < 2 ? 0 : lerp(0.4, 0.9, t),
      // 편대 순환 3바퀴째(9스테이지)부터 스팅어 체력 +1
      bonusHp: cycle >= 2 ? 1 : 0,
    };
  }

  function slotX(col) {
    return WIDTH / 2 + (col - (GRID_COLS - 1) / 2) * SLOT_SPACING_X;
  }

  function slotY(row) {
    return FORMATION_TOP + row * SLOT_SPACING_Y;
  }

  /** 스테이지의 적 배치 목록 생성 */
  function buildFormation(level) {
    const cfg = levelConfig(level);
    const specs = [];
    cfg.formation.rows.forEach((line, row) => {
      for (let col = 0; col < line.length; col++) {
        const type = TYPE_BY_CHAR[line[col]];
        if (!type) continue;
        let hp = ENEMY_TYPES[type].hp;
        if (type === 'stinger') hp += cfg.bonusHp;
        specs.push({ type, row, col, hp, slotX: slotX(col), slotY: slotY(row) });
      }
    });
    specs.forEach((s, i) => {
      s.group = Math.floor(i / ENTRY_GROUP_SIZE);
      s.order = i % ENTRY_GROUP_SIZE;
    });
    return specs;
  }

  /**
   * 편대 슬롯의 현재 위치. 좌우로 흔들리고(sway), 모두 자리를 잡으면 숨쉬듯 확장(breathe)합니다.
   * breathe는 0~1 사이의 강도입니다.
   */
  function slotPosition(spec, time, cfg, breathe) {
    const sway = Math.sin(time * cfg.swaySpeed) * 26;
    const k = 1 + 0.07 * (breathe || 0) * (0.5 - 0.5 * Math.cos(time * 1.6));
    const cy = FORMATION_TOP - 10;
    return {
      x: WIDTH / 2 + (spec.slotX - WIDTH / 2) * k + sway,
      y: cy + (spec.slotY - cy) * k,
    };
  }

  function mirrorX(p, mirror) {
    return { x: mirror ? WIDTH - p.x : p.x, y: p.y };
  }

  /**
   * 입장 경로 세그먼트. 마지막 세그먼트는 toSlot=true로, 끝점이 매 프레임 슬롯 위치로 계산됩니다.
   */
  function entrySegments(group, cfg) {
    const pattern = ENTRY_PATTERNS[Math.floor(group / 2) % ENTRY_PATTERNS.length];
    const mirror = group % 2 === 1;
    const pts = pattern.map((p) => mirrorX(p, mirror));
    const sp = cfg.entrySpeed;
    return [
      { p0: pts[0], p1: pts[1], p2: pts[2], p3: pts[3], dur: 1.5 / sp },
      {
        p0: pts[3],
        p1: mirrorX({ x: 240, y: pts[3].y + 20 }, mirror),
        toSlot: true,
        slotCtrlDy: 110,
        dur: 1.2 / sp,
      },
    ];
  }

  function entryDelay(group, order, cfg) {
    const sp = cfg.entrySpeed;
    return 0.6 + (group * 1.25) / sp + (order * 0.13) / sp;
  }

  /**
   * 급강하 공격 경로: 바깥쪽으로 고리를 그린 뒤 targetX를 향해 내리꽂고,
   * 화면 아래로 빠져나가면 위에서 다시 나타나 슬롯으로 돌아갑니다.
   */
  function diveSegments(start, targetX, cfg, rand) {
    const rnd = rand || Math.random;
    const dir = start.x < WIDTH / 2 ? -1 : 1;
    const tx = clamp(targetX, 30, WIDTH - 30);
    const speed = cfg.diveSpeed;
    const exitY = HEIGHT + 40;
    const loopEnd = { x: start.x + dir * 36, y: start.y + 70 };
    const segs = [
      {
        p0: { x: start.x, y: start.y },
        p1: { x: start.x + dir * 46, y: start.y - 58 },
        p2: { x: start.x + dir * 96, y: start.y + 12 },
        p3: loopEnd,
        dur: 0.75,
      },
    ];
    if (rnd() < cfg.zigzagChance) {
      const mid = { x: clamp(tx + dir * 90, 20, WIDTH - 20), y: HEIGHT * 0.58 };
      const end = { x: clamp(tx - dir * 70, -20, WIDTH + 20), y: exitY };
      segs.push({
        p0: loopEnd,
        p1: { x: loopEnd.x, y: loopEnd.y + 140 },
        p2: { x: mid.x, y: mid.y - 120 },
        p3: mid,
        dur: (dist(loopEnd, mid) * 1.2) / speed,
        attack: true,
      });
      segs.push({
        p0: mid,
        p1: { x: mid.x, y: mid.y + 80 },
        p2: { x: tx, y: PLAYER_Y - 60 },
        p3: end,
        dur: (dist(mid, end) * 1.15) / speed,
      });
    } else {
      const end = { x: tx - dir * 30, y: exitY };
      segs.push({
        p0: loopEnd,
        p1: { x: loopEnd.x, y: loopEnd.y + 170 },
        p2: { x: tx, y: HEIGHT - 260 },
        p3: end,
        dur: (dist(loopEnd, end) * 1.15) / speed,
        attack: true,
      });
    }
    const reenterX = clamp(segs[segs.length - 1].p3.x, 20, WIDTH - 20);
    segs.push({
      p0: { x: reenterX, y: -30 },
      p1: { x: reenterX, y: 60 },
      toSlot: true,
      slotCtrlDy: -70,
      dur: 1.5,
      returning: true,
    });
    return segs;
  }

  /** 호위기용: 경로의 모든 고정점을 (dx, dy)만큼 평행이동한 복사본 */
  function offsetSegments(segs, dx, dy) {
    const off = (p) => (p ? { x: p.x + dx, y: p.y + dy } : p);
    return segs.map((s) => {
      const copy = Object.assign({}, s, { p0: off(s.p0), p1: off(s.p1) });
      if (!s.toSlot) {
        copy.p2 = off(s.p2);
        copy.p3 = off(s.p3);
      }
      return copy;
    });
  }

  function extraLifeCount(score) {
    if (score < EXTRA_LIFE_FIRST) return 0;
    return 1 + Math.floor((score - EXTRA_LIFE_FIRST) / EXTRA_LIFE_EVERY);
  }

  /** prev → next 점수 변화로 얻는 보너스 생명 수 */
  function extraLivesEarned(prev, next) {
    return Math.max(0, extraLifeCount(next) - extraLifeCount(prev));
  }

  function levelClearBonus(level) {
    return Math.min(5000, 500 + 250 * (Math.max(1, level) - 1));
  }

  function accuracy(shots, hits) {
    if (!shots) return 0;
    return Math.round(clamp(hits / shots, 0, 1) * 100);
  }

  function formatScore(n) {
    return String(Math.max(0, Math.floor(n) || 0)).padStart(6, '0');
  }

  /**
   * localStorage(또는 같은 인터페이스) 기반 최고 점수 저장소.
   * 저장소가 없거나 예외를 던지거나 값이 손상되어도 안전하게 동작합니다.
   */
  function createHighScoreStore(storage, key) {
    const k = key || 'neonSwarm.highScore';
    function read() {
      try {
        if (!storage) return 0;
        const v = parseInt(storage.getItem(k), 10);
        return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_SCORE) : 0;
      } catch (e) {
        return 0;
      }
    }
    let best = read();
    return {
      get() {
        return best;
      },
      /** 새 최고 점수면 저장하고 true 반환 */
      submit(score) {
        const s = Math.min(MAX_SCORE, Math.max(0, Math.floor(Number(score) || 0)));
        if (s <= best) return false;
        best = s;
        try {
          if (storage) storage.setItem(k, String(s));
        } catch (e) {
          /* 저장 실패(사생활 보호 모드 등)는 무시 — 이번 세션 동안은 메모리에 유지 */
        }
        return true;
      },
    };
  }

  return {
    WIDTH,
    HEIGHT,
    PLAYER_Y,
    GRID_COLS,
    FORMATION_TOP,
    ENEMY_TYPES,
    FORMATIONS,
    ENTRY_PATTERNS,
    EXTRA_LIFE_FIRST,
    EXTRA_LIFE_EVERY,
    MAX_SCORE,
    clamp,
    lerp,
    dist,
    bezier,
    overlaps,
    makeRng,
    levelConfig,
    buildFormation,
    slotPosition,
    entrySegments,
    entryDelay,
    diveSegments,
    offsetSegments,
    extraLivesEarned,
    levelClearBonus,
    accuracy,
    formatScore,
    createHighScoreStore,
  };
});
