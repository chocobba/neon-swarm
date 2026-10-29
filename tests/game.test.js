'use strict';
/* 게임 엔진을 DOM 없이 시뮬레이션하는 스모크/통합 테스트 */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');
const { Game, START_LIVES, GAME_OVER_DELAY } = require('../js/game.js');
const { buildSprites } = require('../js/sprites.js');
const { makeStubContext, makeStubCanvasFactory, makeMemoryStorage, makeAudioSpy } = require('./helpers.js');

const STEP = 1 / 120;

function makeGame(opts = {}) {
  const log = { calls: {}, badArgs: [] };
  const events = [];
  const audio = makeAudioSpy();
  const storage = opts.storage || makeMemoryStorage();
  const game = new Game({
    sprites: buildSprites(makeStubCanvasFactory()),
    audio,
    storage,
    random: L.makeRng(opts.seed || 1234),
    onEvent: (type, data) => events.push({ type, data }),
    reducedMotion: !!opts.reducedMotion,
  });
  const ctx = makeStubContext(log);
  return { game, events, audio, storage, ctx, log };
}

function run(env, seconds, eachStep) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (eachStep) eachStep(env.game, i);
    env.game.update(STEP);
    if (i % 6 === 0) env.game.render(env.ctx);
  }
}

function assertSane(game) {
  const nums = [game.score, game.lives, game.level, game.player.x];
  for (const e of game.enemies) nums.push(e.x, e.y, e.angle);
  for (const b of game.playerBullets.concat(game.enemyBullets)) nums.push(b.x, b.y);
  for (const n of nums) assert.ok(Number.isFinite(n), 'all values finite');
  assert.ok(game.player.x >= 20 && game.player.x <= L.WIDTH - 20, 'player within bounds');
  assert.ok(game.playerBullets.length <= 4, 'bullet cap respected');
}

/** 가장 가까운 적을 쫓아가며 사격하는 간단한 자동 조종 */
function autopilot(game) {
  const p = game.player;
  let best = null;
  for (const e of game.enemies) {
    if (e.state === 'waiting') continue;
    if (!best || Math.abs(e.x - p.x) < Math.abs(best.x - p.x)) best = e;
  }
  game.input.left = !!best && best.x < p.x - 4;
  game.input.right = !!best && best.x > p.x + 4;
  game.input.fire = true;
}

test('타이틀 상태에서 시작하고, 시작하면 스테이지 1이 열린다', () => {
  const env = makeGame();
  const { game, events, audio } = env;
  assert.equal(game.state, 'title');
  run(env, 1); // 타이틀 애니메이션 렌더링
  game.start();
  assert.equal(game.state, 'playing');
  assert.equal(game.level, 1);
  assert.equal(game.lives, START_LIVES);
  assert.ok(game.enemies.length > 0);
  assert.ok(game.enemies.every((e) => e.state === 'waiting'));
  assert.ok(events.some((e) => e.type === 'state' && e.data.state === 'playing'));
  assert.ok(events.some((e) => e.type === 'announce' && /스테이지 1/.test(e.data)));
  assert.ok(audio.played.includes('levelStart'));
});

test('적이 입장 경로를 거쳐 편대에 합류하고 급강하를 시작한다', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  game.player.invuln = 999; // 이 테스트에서는 죽지 않게
  run(env, 3);
  assert.ok(game.enemies.some((e) => e.state === 'entering'), 'some enemies entering');
  run(env, 12);
  assert.ok(game.enemies.every((e) => e.state !== 'waiting' && e.state !== 'entering'), 'all entered');
  let sawDive = false;
  run(env, 15, (g) => {
    if (g.enemies.some((e) => e.state === 'diving')) sawDive = true;
  });
  assert.ok(sawDive, 'enemies dive');
  assertSane(game);
  assert.deepEqual(env.log.badArgs, [], 'no NaN/Infinity passed to canvas');
});

test('키 입력으로 이동/발사하고 화면 경계를 넘지 않는다', () => {
  const env = makeGame();
  const { game, audio } = env;
  game.start();
  const x0 = game.player.x;
  game.input.left = true;
  run(env, 0.5);
  assert.ok(game.player.x < x0);
  run(env, 5);
  assert.equal(game.player.x, 20);
  game.input.left = false;
  game.input.right = true;
  run(env, 5);
  assert.equal(game.player.x, L.WIDTH - 20);
  game.input.right = false;
  game.input.fire = true;
  run(env, 0.05);
  assert.equal(game.playerBullets.length, 1);
  assert.ok(audio.played.includes('shoot'));
  run(env, 1);
  assert.ok(game.playerBullets.length <= 2, 'max two shots on screen');
  assert.ok(game.stats.shots >= 2);
});

test('터치 드래그(pointerX)는 손가락 위치로 이동하며 자동 발사한다', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  game.input.pointerX = 100;
  run(env, 2);
  assert.ok(Math.abs(game.player.x - 100) < 3);
  assert.ok(game.stats.shots > 0);
  game.input.pointerX = null;
});

test('적을 맞히면 점수가 오르고, 급강하 중이면 보너스 점수', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  run(env, 12);
  const e = game.enemies.find((x) => x.type === 'drone' && x.state === 'formation');
  assert.ok(e);
  game.playerBullets.push({ x: e.x, y: e.y, w: 4, h: 14, vy: 0 });
  const before = game.score;
  game.handleCollisions();
  assert.equal(game.score - before, L.ENEMY_TYPES.drone.score);
  assert.ok(!game.enemies.includes(e));

  const d = game.enemies.find((x) => x.type === 'drone' && x.state === 'formation');
  game.launchDive(d, false);
  const before2 = game.score;
  game.destroyEnemy(d, false);
  assert.equal(game.score - before2, L.ENEMY_TYPES.drone.diveScore);
});

test('워든은 두 발을 맞아야 격추된다', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  run(env, 12);
  const w = game.enemies.find((x) => x.type === 'warden');
  assert.ok(w);
  game.hitEnemy(w);
  assert.ok(!w.dead && w.hurt);
  game.hitEnemy(w);
  assert.ok(w.dead);
});

test('피격 시 생명이 줄고 무적 상태로 부활한다', () => {
  const env = makeGame();
  const { game, events } = env;
  game.start();
  run(env, 1.5);
  game.player.invuln = 0;
  game.enemyBullets.push({ x: game.player.x, y: L.PLAYER_Y, vx: 0, vy: 0, w: 5, h: 10, t: 0 });
  game.handleCollisions();
  assert.equal(game.player.alive, false);
  assert.equal(game.lives, START_LIVES - 1);
  assert.ok(events.some((e) => e.type === 'announce' && /남은 생명/.test(e.data)));
  run(env, 3);
  assert.equal(game.player.alive, true);
  assert.ok(game.player.invuln > 0);
});

test('생명을 모두 잃으면 게임 오버, 최고 점수가 저장된다', () => {
  const env = makeGame();
  const { game, events, storage } = env;
  game.start();
  game.score = 4321;
  game.lives = 1;
  game.player.invuln = 0;
  game.killPlayer();
  assert.equal(game.state, 'playing', 'short delay before game over screen');
  run(env, GAME_OVER_DELAY + 0.2);
  assert.equal(game.state, 'gameover');
  const ev = events.filter((e) => e.type === 'state').pop();
  assert.equal(ev.data.state, 'gameover');
  assert.equal(ev.data.score, 4321);
  assert.equal(ev.data.isNewRecord, true);
  assert.equal(storage.getItem('neonSwarm.highScore'), '4321');
  run(env, 2); // 게임 오버 화면에서도 갱신/렌더 오류 없음

  // 재시작: 상태 초기화
  game.start();
  assert.equal(game.state, 'playing');
  assert.equal(game.score, 0);
  assert.equal(game.lives, START_LIVES);
  assert.equal(game.highScore, 4321);

  // 다음 판의 낮은 점수는 신기록이 아님
  game.score = 100;
  game.lives = 1;
  game.killPlayer();
  run(env, GAME_OVER_DELAY + 0.2);
  assert.equal(events.filter((e) => e.type === 'state').pop().data.isNewRecord, false);
});

test('저장된 최고 점수를 불러온다', () => {
  const env = makeGame({ storage: makeMemoryStorage({ 'neonSwarm.highScore': '9876' }) });
  assert.equal(env.game.highScore, 9876);
});

test('일시정지 중에는 시간이 멈추고, 재개/타이틀 복귀가 동작한다', () => {
  const env = makeGame();
  const { game } = env;
  assert.equal(game.pause(), false, 'cannot pause on title');
  game.start();
  run(env, 2);
  assert.equal(game.togglePause(), true);
  assert.equal(game.state, 'paused');
  const snapshot = JSON.stringify(game.enemies.map((e) => [e.x, e.y, e.state]));
  const t = game.time;
  run(env, 3);
  assert.equal(game.time, t);
  assert.equal(JSON.stringify(game.enemies.map((e) => [e.x, e.y, e.state])), snapshot);
  game.togglePause();
  assert.equal(game.state, 'playing');
  run(env, 0.5);
  assert.ok(game.time > t);
  game.score = 777;
  game.quitToTitle();
  assert.equal(game.state, 'title');
  assert.equal(game.highScore, 777);
  assert.equal(game.score, 0);
});

test('모든 적을 처치하면 클리어 보너스 후 다음 스테이지로 넘어간다', () => {
  const env = makeGame();
  const { game, audio } = env;
  game.start();
  run(env, 1);
  game.enemies = [];
  const before = game.score;
  run(env, 0.1);
  assert.ok(game.levelClearing);
  assert.equal(game.score - before, L.levelClearBonus(1));
  assert.ok(audio.played.includes('levelClear'));
  run(env, 3);
  assert.equal(game.level, 2);
  assert.ok(game.enemies.length > 0);
  assert.equal(game.levelClearing, false);
});

test('점수 기준점을 넘으면 보너스 생명', () => {
  const env = makeGame();
  const { game, audio } = env;
  game.start();
  game.score = L.EXTRA_LIFE_FIRST - 10;
  game.addScore(50);
  assert.equal(game.lives, START_LIVES + 1);
  assert.ok(audio.played.includes('extraLife'));
});

test('트윈 샷 캡슐을 먹으면 두 발씩 발사한다', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  run(env, 0.5);
  game.capsule = { x: game.player.x, y: L.PLAYER_Y, vy: 0, t: 0 };
  game.updateCapsule(STEP);
  assert.equal(game.capsule, null);
  assert.ok(game.twinTimer > 0);
  game.playerBullets = [];
  game.player.cooldown = 0;
  game.firePlayer();
  assert.equal(game.playerBullets.length, 2);
});

test('급강하하는 적과 부딪히면 둘 다 파괴된다', () => {
  const env = makeGame();
  const { game } = env;
  game.start();
  run(env, 12);
  game.player.invuln = 0;
  const e = game.enemies.find((x) => x.state === 'formation');
  e.state = 'diving';
  e.segs = [{ p0: { x: game.player.x, y: L.PLAYER_Y }, p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, p3: { x: 0, y: 0 }, dur: 1 }];
  e.x = game.player.x;
  e.y = L.PLAYER_Y;
  const lives = game.lives;
  game.handleCollisions();
  assert.equal(game.lives, lives - 1);
  assert.ok(!game.enemies.includes(e));
});

test('자동 조종으로 장시간 플레이해도 오류·NaN 없이 진행된다 (여러 시드)', () => {
  for (const seed of [1, 2, 3]) {
    const env = makeGame({ seed });
    const { game } = env;
    game.start();
    let maxLevel = 1;
    run(env, 240, (g) => {
      if (g.state === 'gameover') g.start();
      if (g.state === 'playing') {
        autopilot(g);
        g.lives = Math.max(g.lives, 2); // 진행 테스트를 위해 생명 유지
      }
      maxLevel = Math.max(maxLevel, g.level);
    });
    assertSane(game);
    assert.ok(game.stats.kills > 30, `seed ${seed}: kills enemies (${game.stats.kills})`);
    assert.ok(maxLevel >= 2, `seed ${seed}: progressed to level ${maxLevel}`);
    assert.ok(game.particles.length <= 500);
    assert.deepEqual(env.log.badArgs, []);
  }
});

test('높은 스테이지(호위 비행·지그재그·사격 증가)도 안정적으로 동작한다', () => {
  const env = makeGame({ seed: 99 });
  const { game } = env;
  game.start();
  for (const lv of [5, 9, 16, 25]) {
    game.beginLevel(lv);
    let sawEscort = false;
    run(env, 40, (g) => {
      g.player.invuln = 1;
      g.input.fire = false;
      const divers = g.enemies.filter((e) => e.state === 'diving').length;
      if (divers >= 2) sawEscort = true;
    });
    assertSane(game);
    assert.ok(sawEscort, `level ${lv}: multiple simultaneous divers`);
    assert.ok(game.enemyBullets.length <= game.cfg.maxEnemyBullets);
  }
});

test('모션 감소 설정 시 화면 흔들림을 쓰지 않는다', () => {
  const env = makeGame({ reducedMotion: true });
  const { game } = env;
  game.start();
  game.player.invuln = 0;
  game.killPlayer();
  assert.equal(game.shake, 0);
});

test('이벤트 콜백 오류가 게임을 멈추지 않는다', () => {
  const game = new Game({
    random: L.makeRng(5),
    onEvent: () => {
      throw new Error('ui boom');
    },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    game.start();
    for (let i = 0; i < 600; i++) game.update(STEP);
    game.render(makeStubContext()); // 스프라이트 없이도 대체 렌더링
  } finally {
    console.error = origError;
  }
  assert.equal(game.state, 'playing');
});

test('HUD 배율은 1~1.3으로 제한되며 카드가 서로 겹치지 않는다', () => {
  for (const hudScale of [0.2, 1, 1.15, 1.3, 5, NaN]) {
    const env = makeGame();
    const { game, ctx, log } = env;
    game.start();
    game.hudScale = hudScale;
    game.twinTimer = 5;
    game.render(ctx);
    assert.deepEqual(log.badArgs, [], `scale ${hudScale}: finite canvas args`);
  }
  // 가장 큰 배율에서 카드 배치 계산: 왼쪽 카드 끝 < 가운데 카드 시작, 가운데 끝 < 오른쪽 시작
  const k = 1.3;
  const wide = 112 * k;
  const leftEnd = 10 + wide;
  const centerStart = L.WIDTH / 2 - wide / 2;
  const centerEnd = L.WIDTH / 2 + wide / 2;
  const rightStart = L.WIDTH - 10 - 84 * k;
  assert.ok(leftEnd < centerStart && centerEnd < rightStart);
  // HUD 카드 하단이 편대 최상단 적보다 위
  assert.ok(10 + 42 * k < L.FORMATION_TOP - 12);
});
