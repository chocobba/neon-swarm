'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');
const S = require('../js/sprites.js');
const { makeMemoryStorage, makeStubCanvasFactory } = require('./helpers.js');

test('편대 배치 데이터가 올바른 형식이다', () => {
  for (const f of L.FORMATIONS) {
    assert.ok(f.name && f.id, 'formation needs id and name');
    assert.equal(f.rows.length, 5);
    for (const row of f.rows) {
      assert.equal(row.length, L.GRID_COLS, `${f.id}: row width`);
      assert.match(row, /^[.WSD]+$/, `${f.id}: invalid chars`);
    }
  }
});

test('모든 스테이지에서 적 배치가 화면 안·중복 없이 생성된다', () => {
  for (let lv = 1; lv <= 30; lv++) {
    const specs = L.buildFormation(lv);
    assert.ok(specs.length >= 20, `level ${lv} has enemies`);
    const keys = new Set(specs.map((s) => `${s.row}:${s.col}`));
    assert.equal(keys.size, specs.length, 'unique slots');
    const cfg = L.levelConfig(lv);
    for (const s of specs) {
      assert.ok(L.ENEMY_TYPES[s.type], 'valid type');
      assert.ok(s.hp >= 1);
      // 흔들림/확장 최대치에서도 화면 안
      for (const t of [0, 0.5, 1, 2, 3.7, 10]) {
        const p = L.slotPosition(s, t, cfg, 1);
        assert.ok(p.x > 12 && p.x < L.WIDTH - 12, `x in bounds (lv ${lv})`);
        assert.ok(p.y > 40 && p.y < L.HEIGHT / 2, 'y in upper half');
      }
      assert.ok(Number.isInteger(s.group) && s.group >= 0);
      assert.ok(Number.isInteger(s.order) && s.order >= 0 && s.order < 8);
    }
  }
});

test('난이도는 스테이지가 오를수록 단조 증가한다', () => {
  let prev = L.levelConfig(1);
  for (let lv = 2; lv <= 40; lv++) {
    const c = L.levelConfig(lv);
    assert.ok(c.diveInterval <= prev.diveInterval, 'dive interval shrinks');
    assert.ok(c.diveSpeed >= prev.diveSpeed, 'dive speed grows');
    assert.ok(c.maxDivers >= prev.maxDivers, 'more divers');
    assert.ok(c.enemyBulletSpeed >= prev.enemyBulletSpeed);
    assert.ok(c.formationFireInterval <= prev.formationFireInterval);
    assert.ok(c.shotsPerDive >= prev.shotsPerDive);
    assert.ok(c.maxEnemyBullets >= prev.maxEnemyBullets);
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} finite`);
    }
    prev = c;
  }
  assert.ok(L.levelConfig(1).maxDivers >= 1);
  assert.ok(L.levelConfig(100).maxDivers <= 7);
  // 비정상 입력도 1스테이지로 처리
  assert.equal(L.levelConfig(0).level, 1);
  assert.equal(L.levelConfig('abc').level, 1);
  // 3번째 순환부터 스팅어 체력 증가
  const late = L.buildFormation(9).filter((s) => s.type === 'stinger');
  assert.ok(late.every((s) => s.hp === 2));
});

test('베지어 곡선은 양 끝점을 지난다', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 10, y: 50 };
  const p2 = { x: 90, y: 50 };
  const p3 = { x: 100, y: 0 };
  assert.deepEqual(L.bezier(p0, p1, p2, p3, 0), p0);
  assert.deepEqual(L.bezier(p0, p1, p2, p3, 1), p3);
  const mid = L.bezier(p0, p1, p2, p3, 0.5);
  assert.equal(mid.x, 50);
  assert.ok(mid.y > 0);
});

test('충돌 판정(중심 기준 사각형)', () => {
  assert.ok(L.overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }));
  assert.ok(!L.overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }));
  assert.ok(!L.overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 30, w: 10, h: 10 }));
});

test('입장 경로는 연속적이고 마지막에 슬롯으로 향한다', () => {
  const cfg = L.levelConfig(1);
  for (let g = 0; g < 8; g++) {
    const segs = L.entrySegments(g, cfg);
    assert.ok(segs.length >= 2);
    assert.ok(segs[segs.length - 1].toSlot);
    for (let i = 1; i < segs.length; i++) assert.deepEqual(segs[i].p0, segs[i - 1].p3);
    assert.ok(segs.every((s) => s.dur > 0));
    // 화면 밖에서 등장
    const start = segs[0].p0;
    assert.ok(start.x < 0 || start.x > L.WIDTH || start.y < 0, 'enters from offscreen');
  }
  assert.ok(L.entryDelay(1, 0, cfg) > L.entryDelay(0, 7, cfg) - 1, 'groups are staggered');
});

test('급강하 경로: 공격 후 화면 아래로 빠져 위에서 복귀', () => {
  for (const lv of [1, 5, 12]) {
    const cfg = L.levelConfig(lv);
    const rng = L.makeRng(lv);
    for (let i = 0; i < 50; i++) {
      const start = { x: 40 + rng() * 400, y: 100 + rng() * 120 };
      const segs = L.diveSegments(start, rng() * 600 - 60, cfg, rng);
      assert.deepEqual(segs[0].p0, start);
      const last = segs[segs.length - 1];
      assert.ok(last.toSlot && last.returning);
      assert.ok(last.p0.y < 0, 'returns from above');
      assert.ok(segs.some((s) => s.attack), 'has an attack segment');
      const exit = segs[segs.length - 2].p3;
      assert.ok(exit.y > L.HEIGHT, 'exits below the screen');
      for (let k = 1; k < segs.length - 1; k++) assert.deepEqual(segs[k].p0, segs[k - 1].p3);
      assert.ok(segs.every((s) => s.dur > 0 && Number.isFinite(s.dur)));
    }
  }
});

test('호위기 경로 오프셋은 원본을 변경하지 않는다', () => {
  const cfg = L.levelConfig(4);
  const segs = L.diveSegments({ x: 200, y: 100 }, 240, cfg, () => 0.9);
  const before = JSON.stringify(segs);
  const off = L.offsetSegments(segs, 20, 10);
  assert.equal(JSON.stringify(segs), before);
  assert.equal(off[0].p0.x, 220);
  assert.equal(off[0].p3.y, segs[0].p3.y + 10);
  assert.ok(off[off.length - 1].toSlot);
  assert.equal(off[off.length - 1].p2, undefined);
});

test('보너스 생명 기준점', () => {
  assert.equal(L.extraLivesEarned(0, 9999), 0);
  assert.equal(L.extraLivesEarned(9990, 10000), 1);
  assert.equal(L.extraLivesEarned(10000, 10050), 0);
  assert.equal(L.extraLivesEarned(39990, 40000), 1);
  assert.equal(L.extraLivesEarned(0, 70000), 3);
  assert.equal(L.extraLivesEarned(500, 100), 0);
});

test('최고 점수 저장소: 정상/손상/예외 상황', () => {
  const mem = makeMemoryStorage();
  const store = L.createHighScoreStore(mem, 'hs');
  assert.equal(store.get(), 0);
  assert.equal(store.submit(1200), true);
  assert.equal(store.submit(800), false);
  assert.equal(store.get(), 1200);
  assert.equal(mem.getItem('hs'), '1200');
  // 다시 열어도 유지
  assert.equal(L.createHighScoreStore(mem, 'hs').get(), 1200);

  assert.equal(L.createHighScoreStore(makeMemoryStorage({ hs: 'garbage' }), 'hs').get(), 0);
  assert.equal(L.createHighScoreStore(makeMemoryStorage({ hs: '-50' }), 'hs').get(), 0);
  assert.equal(L.createHighScoreStore(makeMemoryStorage({ hs: '1e99' }), 'hs').get(), 1);
  assert.equal(L.createHighScoreStore(makeMemoryStorage({ hs: '999999999999' }), 'hs').get(), L.MAX_SCORE);

  const throwing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const t = L.createHighScoreStore(throwing, 'hs');
  assert.equal(t.get(), 0);
  assert.equal(t.submit(500), true, 'keeps score in memory even if storage fails');
  assert.equal(t.get(), 500);

  const none = L.createHighScoreStore(null);
  assert.equal(none.submit(10), true);
  assert.equal(none.submit(NaN), false);
});

test('보조 함수들', () => {
  assert.equal(L.formatScore(42), '000042');
  assert.equal(L.formatScore(-5), '000000');
  assert.equal(L.formatScore(1234567), '1234567');
  assert.equal(L.accuracy(0, 0), 0);
  assert.equal(L.accuracy(4, 3), 75);
  assert.equal(L.accuracy(2, 5), 100);
  assert.equal(L.levelClearBonus(1), 500);
  assert.ok(L.levelClearBonus(100) <= 5000);
  const a = L.makeRng(7);
  const b = L.makeRng(7);
  for (let i = 0; i < 10; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('스프라이트 픽셀 맵이 유효하고 렌더링된다', () => {
  const check = (rows, palette, name) => {
    const w = rows[0].length;
    for (const r of rows) {
      assert.equal(r.length, w, `${name}: equal row widths`);
      for (const ch of r) assert.ok(ch === '.' || palette[ch], `${name}: color for '${ch}'`);
    }
  };
  check(S.ART.player, S.PALETTES.player, 'player');
  for (const type of ['drone', 'stinger', 'warden']) {
    assert.equal(S.ART[type].length, 2, `${type}: two animation frames`);
    S.ART[type].forEach((rows) => {
      check(rows, S.PALETTES[type], type);
      assert.equal(rows.length, S.ART[type][0].length, `${type}: frames same height`);
    });
    // 스프라이트 크기가 적 히트박스와 일치
    assert.equal(S.ART[type][0][0].length * S.PIXEL, L.ENEMY_TYPES[type].w, `${type}: width matches hitbox`);
  }
  S.ART.warden.forEach((rows) => check(rows, S.PALETTES.wardenHurt, 'wardenHurt'));

  const log = { calls: {}, badArgs: [] };
  const sprites = S.buildSprites(makeStubCanvasFactory(log));
  assert.ok(sprites.player.canvas && sprites.player.w > 0);
  assert.equal(sprites.drone.length, 2);
  assert.equal(sprites.flash.warden.length, 2);
  assert.ok(log.calls.fillRect > 100);
  assert.deepEqual(log.badArgs, []);
});
