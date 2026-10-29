/*
 * NEON SWARM — 게임 엔진
 * 상태 머신, 개체 갱신, 충돌, 렌더링을 담당합니다. DOM에 직접 접근하지 않으며
 * (스프라이트·오디오·저장소·이벤트 콜백을 주입받음) Node에서도 시뮬레이션할 수 있습니다.
 *
 * 상태: 'title' → 'playing' ⇄ 'paused' → 'gameover' → 'playing' | 'title'
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./logic.js') : root.NeonLogic);
  if (isNode) module.exports = api;
  else root.NeonGame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (L) {
  'use strict';

  const W = L.WIDTH;
  const H = L.HEIGHT;
  const PLAYER_Y = L.PLAYER_Y;

  const PLAYER_SPEED = 250;
  const PLAYER_BULLET_SPEED = 560;
  const FIRE_COOLDOWN = 0.17;
  const START_LIVES = 3;
  const MAX_LIVES = 6;
  const RESPAWN_DELAY = 2.0;
  const INVULN_TIME = 2.4;
  const TWIN_DURATION = 12;
  const GAME_OVER_DELAY = 2.2;
  const LEVEL_CLEAR_DELAY = 2.6;

  const COLORS = {
    cyan: '#3cf0ff',
    magenta: '#ff3cac',
    yellow: '#ffd23c',
    orange: '#ff7a3c',
    purple: '#b44cff',
    green: '#3cff9a',
    white: '#ffffff',
  };
  const TYPE_COLOR = { drone: COLORS.cyan, stinger: COLORS.magenta, warden: COLORS.yellow };
  // 한글 라벨은 시스템 산세리프, 숫자는 고정폭 — 로컬 폰트만 사용
  const FONT_UI = 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Segoe UI", sans-serif';
  const FONT_NUM = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace';
  const UI = {
    card: 'rgba(8, 12, 34, 0.66)',
    line: 'rgba(130, 150, 255, 0.2)',
    label: '#8f9ac6',
    text: '#eef1ff',
    high: '#ffd86b',
  };

  const noop = () => {};
  const SILENT_AUDIO = { play: noop };

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCard(ctx, x, y, w, h) {
    roundRectPath(ctx, x, y, w, h, 8);
    ctx.fillStyle = UI.card;
    ctx.fill();
    ctx.strokeStyle = UI.line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function smoothstep(a, b, x) {
    const t = L.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  class Game {
    /**
     * @param {object} opts
     * @param {object} [opts.sprites]  NeonSprites.buildSprites() 결과
     * @param {{play(name:string):void}} [opts.audio]
     * @param {Storage} [opts.storage]  최고 점수 저장소
     * @param {() => number} [opts.random]
     * @param {(type:string, data:any) => void} [opts.onEvent]
     * @param {boolean} [opts.reducedMotion]
     */
    constructor(opts = {}) {
      this.sprites = opts.sprites || null;
      this.audio = opts.audio || SILENT_AUDIO;
      this.rng = opts.random || Math.random;
      this.onEvent = opts.onEvent || noop;
      this.reducedMotion = !!opts.reducedMotion;
      // 캔버스가 작게 표시될 때 HUD 글자를 읽을 수 있도록 키우는 배율 (main.js가 화면 크기에 맞춰 설정)
      this.hudScale = 1;
      this.highScores = L.createHighScoreStore(opts.storage || null);
      this.highScore = this.highScores.get();
      this.input = { left: false, right: false, fire: false, pointerX: null };
      this.state = 'title';
      this.time = 0;
      this.stars = this.makeStars(90);
      this.gridScroll = 0;
      this.nextId = 1;
      this.resetRun();
    }

    // ───────────────────────── 상태 전환 ─────────────────────────

    emit(type, data) {
      try {
        this.onEvent(type, data);
      } catch (e) {
        /* UI 콜백 오류가 게임 루프를 멈추지 않도록 */
        if (typeof console !== 'undefined') console.error(e);
      }
    }

    setState(state, data) {
      this.state = state;
      this.emit('state', Object.assign({ state }, data || {}));
    }

    resetRun() {
      this.score = 0;
      this.lives = START_LIVES;
      this.level = 1;
      this.cfg = L.levelConfig(1);
      this.enemies = [];
      this.playerBullets = [];
      this.enemyBullets = [];
      this.particles = [];
      this.rings = [];
      this.floaters = [];
      this.capsule = null;
      this.banner = null;
      this.player = { x: W / 2, alive: true, cooldown: 0, invuln: 0, respawnTimer: 0, tilt: 0, muzzle: 0 };
      this.stats = { shots: 0, hits: 0, kills: 0 };
      this.twinTimer = 0;
      this.gameOverTimer = 0;
      this.levelClearing = false;
      this.clearTimer = 0;
      this.diveTimer = 0;
      this.formationFireTimer = 0;
      this.formationTime = 0;
      this.breathe = 0;
      this.shake = 0;
      this.warp = 0;
      this.runStartHigh = this.highScore;
    }

    start() {
      this.resetRun();
      this.runStartHigh = this.highScore;
      this.player.invuln = 1.0;
      this.beginLevel(1);
      this.setState('playing');
    }

    pause() {
      if (this.state !== 'playing') return false;
      this.highScores.submit(this.score);
      this.setState('paused');
      return true;
    }

    resume() {
      if (this.state !== 'paused') return false;
      this.setState('playing');
      return true;
    }

    togglePause() {
      return this.state === 'paused' ? this.resume() : this.pause();
    }

    quitToTitle() {
      this.highScores.submit(this.score);
      this.highScore = this.highScores.get();
      this.resetRun();
      this.setState('title');
    }

    endGame() {
      const isNewRecord = this.score > this.runStartHigh;
      this.highScores.submit(this.score);
      this.highScore = this.highScores.get();
      this.audio.play('gameOver');
      this.setState('gameover', {
        score: this.score,
        highScore: this.highScore,
        isNewRecord,
        level: this.level,
        kills: this.stats.kills,
        accuracy: L.accuracy(this.stats.shots, this.stats.hits),
      });
    }

    beginLevel(n) {
      this.level = n;
      this.cfg = L.levelConfig(n);
      this.levelClearing = false;
      this.formationTime = 0;
      this.breathe = 0;
      this.enemies = L.buildFormation(n).map((spec) => this.makeEnemy(spec));
      this.playerBullets = [];
      this.enemyBullets = [];
      this.capsule = null;
      this.diveTimer = 2.5;
      this.formationFireTimer = this.cfg.formationFireInterval + 2;
      this.showBanner(`스테이지 ${n}`, `${this.cfg.formation.name} 편대 접근 중`, 2.4);
      this.audio.play('levelStart');
      this.emit('announce', `스테이지 ${n} 시작. ${this.cfg.formation.name} 편대.`);
    }

    makeEnemy(spec) {
      return Object.assign({}, spec, {
        id: this.nextId++,
        x: -100,
        y: -100,
        state: 'waiting',
        delay: L.entryDelay(spec.group, spec.order, this.cfg),
        entry: L.entrySegments(spec.group, this.cfg),
        segs: null,
        segIndex: 0,
        segT: 0,
        shots: null,
        anim: this.rng() * 2,
        angle: 0,
        flash: 0,
        hurt: false,
        dead: false,
      });
    }

    showBanner(text, sub, dur) {
      this.banner = { text, sub: sub || '', t: 0, dur };
    }

    // ───────────────────────── 갱신 ─────────────────────────

    update(dt) {
      if (this.state === 'paused') return;
      this.time += dt;
      this.updateStars(dt);
      this.updateParticles(dt);
      if (this.state === 'title') return;
      if (this.state === 'gameover') {
        this.formationTime += dt;
        this.updateEnemies(dt);
        this.updateBullets(dt);
        return;
      }
      // playing
      if (this.banner) {
        this.banner.t += dt;
        if (this.banner.t >= this.banner.dur) this.banner = null;
      }
      this.shake = Math.max(0, this.shake - dt * 18);
      this.updatePlayer(dt);
      this.updateFormation(dt);
      this.updateEnemies(dt);
      this.updateDiveAI(dt);
      this.updateFormationFire(dt);
      this.updateBullets(dt);
      this.updateCapsule(dt);
      this.handleCollisions();
      this.updateFlow(dt);
    }

    updatePlayer(dt) {
      const p = this.player;
      p.cooldown = Math.max(0, p.cooldown - dt);
      p.muzzle = Math.max(0, p.muzzle - dt);
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (this.twinTimer > 0) this.twinTimer = Math.max(0, this.twinTimer - dt);
      if (!p.alive) {
        if (this.lives > 0) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) this.respawnPlayer();
        }
        return;
      }
      const inp = this.input;
      let dir = (inp.left ? -1 : 0) + (inp.right ? 1 : 0);
      let speed = PLAYER_SPEED;
      let fire = inp.fire;
      if (inp.pointerX !== null && inp.pointerX !== undefined && Number.isFinite(inp.pointerX)) {
        // 터치/드래그: 손가락 위치를 따라가며 자동 발사
        const diff = inp.pointerX - p.x;
        dir = Math.abs(diff) < 2 ? 0 : Math.sign(diff);
        speed = Math.min(PLAYER_SPEED * 1.3, Math.abs(diff) / dt);
        fire = true;
      }
      p.x = L.clamp(p.x + dir * speed * dt, 20, W - 20);
      p.tilt += (dir - p.tilt) * Math.min(1, dt * 10);
      if (fire && p.cooldown <= 0) this.firePlayer();
    }

    firePlayer() {
      const p = this.player;
      const twin = this.twinTimer > 0;
      const need = twin ? 2 : 1;
      const max = twin ? 4 : 2;
      if (this.playerBullets.length + need > max) return;
      const y = PLAYER_Y - 14;
      if (twin) {
        this.playerBullets.push(this.makeBullet(p.x - 7, y), this.makeBullet(p.x + 7, y));
      } else {
        this.playerBullets.push(this.makeBullet(p.x, y));
      }
      this.stats.shots += need;
      p.cooldown = FIRE_COOLDOWN;
      p.muzzle = 0.06;
      this.audio.play('shoot');
    }

    makeBullet(x, y) {
      return { x, y, w: 4, h: 14, vy: -PLAYER_BULLET_SPEED };
    }

    respawnPlayer() {
      // 급강하 중인 적이 바닥 근처에 있으면 잠시 대기
      const danger = this.enemies.some((e) => (e.state === 'diving' || e.state === 'returning') && e.y > H - 170 && e.y < H);
      if (danger) {
        this.player.respawnTimer = 0.3;
        return;
      }
      Object.assign(this.player, { x: W / 2, alive: true, invuln: INVULN_TIME, cooldown: 0.3, tilt: 0 });
      this.enemyBullets = [];
    }

    updateFormation(dt) {
      this.formationTime += dt;
      const settled = this.enemies.length > 0 && this.enemies.every((e) => e.state !== 'waiting' && e.state !== 'entering');
      if (settled) this.breathe = Math.min(1, this.breathe + dt * 0.5);
    }

    slotOf(e) {
      return L.slotPosition(e, this.formationTime, this.cfg, this.breathe);
    }

    updateEnemies(dt) {
      for (const e of this.enemies) {
        if (e.dead) continue;
        e.anim += dt * (e.state === 'formation' ? 1 : 2.4);
        if (e.flash > 0) e.flash -= dt;
        if (e.state === 'waiting') {
          e.delay -= dt;
          if (e.delay > 0) continue;
          e.state = 'entering';
          this.startPath(e, e.entry);
        }
        if (e.state === 'formation') {
          const s = this.slotOf(e);
          e.x = s.x;
          e.y = s.y;
          e.angle += angleDiff(0, e.angle) * Math.min(1, dt * 6);
          continue;
        }
        this.followPath(e, dt);
      }
    }

    startPath(e, segs) {
      e.segs = segs;
      e.segIndex = 0;
      e.segT = 0;
      this.onSegmentStart(e, segs[0]);
    }

    onSegmentStart(e, seg) {
      e.x = seg.p0.x;
      e.y = seg.p0.y;
      e.shots = null;
      if (seg.attack) {
        const shots = [];
        for (let i = 0; i < this.cfg.shotsPerDive; i++) {
          if (this.rng() < this.cfg.fireChance) shots.push(0.12 + this.rng() * 0.5);
        }
        e.shots = shots.sort((a, b) => a - b);
      }
      if (seg.returning) e.state = 'returning';
    }

    followPath(e, dt) {
      let seg = e.segs[e.segIndex];
      e.segT += dt / seg.dur;
      while (e.segT >= 1) {
        e.segIndex++;
        if (e.segIndex >= e.segs.length) {
          e.state = 'formation';
          e.segs = null;
          e.shots = null;
          const s = this.slotOf(e);
          e.x = s.x;
          e.y = s.y;
          return;
        }
        seg = e.segs[e.segIndex];
        e.segT = 0;
        this.onSegmentStart(e, seg);
      }
      const t = e.segT;
      let p2 = seg.p2;
      let p3 = seg.p3;
      if (seg.toSlot) {
        p3 = this.slotOf(e);
        p2 = { x: p3.x, y: p3.y + seg.slotCtrlDy };
      }
      const pos = L.bezier(seg.p0, seg.p1, p2, p3, t);
      const dx = pos.x - e.x;
      const dy = pos.y - e.y;
      if (dx * dx + dy * dy > 0.0001) {
        let target = Math.atan2(dy, dx) - Math.PI / 2;
        if (seg.toSlot) target = angleDiff(target, 0) * (1 - smoothstep(0.65, 1, t));
        e.angle += angleDiff(target, e.angle) * Math.min(1, dt * 12);
      }
      e.x = pos.x;
      e.y = pos.y;
      if (e.shots && e.shots.length && this.state === 'playing') {
        while (e.shots.length && t >= e.shots[0]) {
          e.shots.shift();
          this.enemyFire(e, 1);
        }
      }
    }

    activeEnemiesEntering() {
      return this.enemies.some((e) => e.state === 'waiting' || e.state === 'entering');
    }

    updateDiveAI(dt) {
      if (!this.player.alive || this.levelClearing || this.gameOverTimer > 0) return;
      if (this.activeEnemiesEntering()) return;
      this.diveTimer -= dt;
      if (this.diveTimer > 0) return;
      const cfg = this.cfg;
      const desperate = this.enemies.length <= 6;
      this.diveTimer = cfg.diveInterval * (0.6 + this.rng() * 0.8) * (desperate ? 0.55 : 1);
      const divers = this.enemies.filter((e) => e.state === 'diving' || e.state === 'returning').length;
      if (divers >= cfg.maxDivers + (desperate ? 1 : 0)) return;
      const pool = this.enemies.filter((e) => e.state === 'formation');
      if (!pool.length) return;
      const wardens = pool.filter((e) => e.type === 'warden');
      const leader = wardens.length && this.rng() < 0.3 ? this.pick(wardens) : this.pick(pool);
      this.launchDive(leader, true);
    }

    pick(arr) {
      return arr[Math.floor(this.rng() * arr.length) % arr.length];
    }

    launchDive(e, allowEscort) {
      const targetX = this.player.x + (this.rng() - 0.5) * 80;
      const segs = L.diveSegments({ x: e.x, y: e.y }, targetX, this.cfg, this.rng);
      e.state = 'diving';
      this.startPath(e, segs);
      this.audio.play('dive');
      if (allowEscort && e.type === 'warden' && this.rng() < this.cfg.escortChance) {
        const escorts = this.enemies
          .filter((o) => o.state === 'formation' && o.type === 'stinger' && o.row === e.row + 1 && Math.abs(o.col - e.col) <= 1)
          .slice(0, 2);
        for (const o of escorts) {
          const dx = L.clamp(o.slotX - e.slotX, -26, 26) || 24;
          const path = L.offsetSegments(segs, dx, 22);
          path[0].p0 = { x: o.x, y: o.y };
          o.state = 'diving';
          this.startPath(o, path);
        }
      }
    }

    updateFormationFire(dt) {
      if (!this.player.alive || this.levelClearing || this.gameOverTimer > 0) return;
      this.formationFireTimer -= dt;
      if (this.formationFireTimer > 0) return;
      this.formationFireTimer = this.cfg.formationFireInterval * (0.5 + this.rng());
      const inFormation = this.enemies.filter((e) => e.state === 'formation');
      // 각 열의 가장 아래쪽 적만 사격
      const shooters = inFormation.filter((e) => !inFormation.some((o) => o.col === e.col && o.row > e.row));
      if (shooters.length) this.enemyFire(this.pick(shooters), 0.3);
    }

    enemyFire(e, aim) {
      if (!this.player.alive) return;
      if (this.enemyBullets.length >= this.cfg.maxEnemyBullets) return;
      if (e.y < 0 || e.y > PLAYER_Y - 90) return;
      const vy = this.cfg.enemyBulletSpeed;
      const dy = Math.max(60, PLAYER_Y - e.y);
      const vx = L.clamp(((this.player.x - e.x) / dy) * vy * aim, -0.45 * vy, 0.45 * vy);
      this.enemyBullets.push({ x: e.x, y: e.y + 10, vx, vy, w: 5, h: 10, t: 0 });
      this.audio.play('enemyShoot');
    }

    updateBullets(dt) {
      for (const b of this.playerBullets) b.y += b.vy * dt;
      this.playerBullets = this.playerBullets.filter((b) => b.y > -20);
      for (const b of this.enemyBullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.t += dt;
      }
      this.enemyBullets = this.enemyBullets.filter((b) => b.y < H + 20 && b.x > -20 && b.x < W + 20);
    }

    updateCapsule(dt) {
      const c = this.capsule;
      if (!c) return;
      c.y += c.vy * dt;
      c.t += dt;
      if (c.y > H + 20) {
        this.capsule = null;
        return;
      }
      const p = this.player;
      if (p.alive && L.overlaps({ x: c.x, y: c.y, w: 20, h: 20 }, this.playerHitbox(8))) {
        this.capsule = null;
        this.twinTimer = TWIN_DURATION;
        this.audio.play('powerup');
        this.addFloater(p.x, PLAYER_Y - 30, '트윈 샷!', COLORS.green);
        this.emit('announce', '트윈 샷 획득! 12초 동안 두 발씩 발사합니다.');
      }
    }

    playerHitbox(extra) {
      const e = extra || 0;
      return { x: this.player.x, y: PLAYER_Y + 2, w: 18 + e, h: 16 + e };
    }

    enemyHitbox(e) {
      const t = L.ENEMY_TYPES[e.type];
      return { x: e.x, y: e.y, w: t.w * 0.9, h: t.h * 0.9 };
    }

    handleCollisions() {
      // 플레이어 탄 → 적
      for (let i = this.playerBullets.length - 1; i >= 0; i--) {
        const b = this.playerBullets[i];
        for (const e of this.enemies) {
          if (e.dead || e.state === 'waiting') continue;
          if (L.overlaps(b, this.enemyHitbox(e))) {
            this.playerBullets.splice(i, 1);
            this.stats.hits++;
            this.hitEnemy(e);
            break;
          }
        }
      }
      const p = this.player;
      if (p.alive && p.invuln <= 0) {
        const hb = this.playerHitbox();
        // 적 탄 → 플레이어
        for (let i = 0; i < this.enemyBullets.length; i++) {
          const b = this.enemyBullets[i];
          if (L.overlaps({ x: b.x, y: b.y, w: 4, h: 8 }, hb)) {
            this.enemyBullets.splice(i, 1);
            this.killPlayer();
            break;
          }
        }
      }
      if (p.alive && p.invuln <= 0) {
        const hb = this.playerHitbox();
        // 적 기체 몸통 충돌
        for (const e of this.enemies) {
          if (e.dead || e.state === 'waiting' || e.state === 'formation') continue;
          if (L.overlaps(this.enemyHitbox(e), hb)) {
            this.destroyEnemy(e, true);
            this.killPlayer();
            break;
          }
        }
      }
      if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
    }

    hitEnemy(e) {
      e.hp--;
      if (e.hp > 0) {
        e.flash = 0.12;
        e.hurt = true;
        this.audio.play('hit');
        this.sparks(e.x, e.y, TYPE_COLOR[e.type], 8);
        return;
      }
      this.destroyEnemy(e, false);
    }

    destroyEnemy(e, byCollision) {
      if (e.dead) return;
      e.dead = true;
      const t = L.ENEMY_TYPES[e.type];
      const diving = e.state === 'diving';
      const pts = diving ? t.diveScore : t.score;
      this.addScore(pts);
      this.stats.kills++;
      if (diving) this.addFloater(e.x, e.y, String(pts), TYPE_COLOR[e.type]);
      const big = e.type === 'warden';
      this.explode(e.x, e.y, TYPE_COLOR[e.type], big ? 34 : 20);
      this.audio.play(big ? 'bigExplode' : 'explode');
      if (big) this.addShake(4);
      if (!byCollision && !this.capsule && !this.levelClearing) {
        const chance = big ? 0.25 : 0.035;
        if (this.rng() < chance) this.capsule = { x: e.x, y: e.y, vy: 85, t: 0 };
      }
    }

    killPlayer() {
      const p = this.player;
      if (!p.alive) return;
      p.alive = false;
      p.respawnTimer = RESPAWN_DELAY;
      this.lives = Math.max(0, this.lives - 1);
      this.twinTimer = 0;
      this.explode(p.x, PLAYER_Y, COLORS.cyan, 40);
      this.explode(p.x, PLAYER_Y, COLORS.magenta, 24);
      this.explode(p.x, PLAYER_Y, COLORS.orange, 16);
      this.addShake(10);
      this.audio.play('playerDie');
      if (this.lives <= 0) {
        this.gameOverTimer = GAME_OVER_DELAY;
        this.highScores.submit(this.score);
      } else {
        this.emit('announce', `격추당했습니다! 남은 생명 ${this.lives}`);
      }
    }

    addScore(n) {
      const prev = this.score;
      this.score = Math.min(L.MAX_SCORE, this.score + n);
      const earned = L.extraLivesEarned(prev, this.score);
      if (earned > 0 && this.lives > 0) {
        this.lives = Math.min(MAX_LIVES, this.lives + earned);
        this.audio.play('extraLife');
        this.addFloater(this.player.x, PLAYER_Y - 40, '1UP!', COLORS.yellow);
        this.emit('announce', `보너스 생명 획득! 생명 ${this.lives}`);
      }
      if (this.score > this.highScore) this.highScore = this.score;
    }

    updateFlow(dt) {
      if (this.gameOverTimer > 0) {
        this.gameOverTimer -= dt;
        if (this.gameOverTimer <= 0) this.endGame();
        return;
      }
      if (!this.levelClearing && this.enemies.length === 0) {
        this.levelClearing = true;
        this.clearTimer = LEVEL_CLEAR_DELAY;
        const bonus = L.levelClearBonus(this.level);
        this.addScore(bonus);
        this.enemyBullets = [];
        this.showBanner(`스테이지 ${this.level} 클리어!`, `보너스 +${bonus}`, LEVEL_CLEAR_DELAY - 0.2);
        this.audio.play('levelClear');
        this.emit('announce', `스테이지 ${this.level} 클리어! 보너스 ${bonus}점.`);
      }
      if (this.levelClearing) {
        this.clearTimer -= dt;
        if (this.clearTimer <= 0) this.beginLevel(this.level + 1);
      }
    }

    // ───────────────────────── 이펙트 ─────────────────────────

    addShake(n) {
      if (!this.reducedMotion) this.shake = Math.max(this.shake, n);
    }

    explode(x, y, color, count) {
      for (let i = 0; i < count; i++) {
        const a = this.rng() * Math.PI * 2;
        const sp = 40 + this.rng() * 200;
        const life = 0.4 + this.rng() * 0.6;
        this.particles.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life,
          max: life,
          size: this.rng() < 0.3 ? 3 : 2,
          color: this.rng() < 0.25 ? COLORS.white : color,
        });
      }
      this.rings.push({ x, y, r: 4, life: 0.35, max: 0.35, color });
      if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
    }

    sparks(x, y, color, count) {
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (this.rng() - 0.5) * 2;
        const sp = 60 + this.rng() * 120;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25, max: 0.25, size: 2, color });
      }
    }

    addFloater(x, y, text, color) {
      this.floaters.push({ x, y, text, color, life: 1, max: 1 });
    }

    updateParticles(dt) {
      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - dt * 1.8;
        p.vy *= 1 - dt * 1.8;
        p.life -= dt;
      }
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const r of this.rings) {
        r.r += dt * 120;
        r.life -= dt;
      }
      this.rings = this.rings.filter((r) => r.life > 0);
      for (const f of this.floaters) {
        f.y -= dt * 30;
        f.life -= dt;
      }
      this.floaters = this.floaters.filter((f) => f.life > 0);
    }

    makeStars(n) {
      const stars = [];
      for (let i = 0; i < n; i++) {
        stars.push({ x: Math.random() * W, y: Math.random() * H, z: i % 3, tw: Math.random() * Math.PI * 2 });
      }
      return stars;
    }

    updateStars(dt) {
      const targetWarp = this.state === 'playing' && this.levelClearing ? (this.reducedMotion ? 0.3 : 1) : 0;
      this.warp += (targetWarp - this.warp) * Math.min(1, dt * 2.5);
      const base = [18, 40, 85];
      for (const s of this.stars) {
        s.y += base[s.z] * (1 + this.warp * 6) * dt;
        if (s.y > H + 10) {
          s.y = -10;
          s.x = Math.random() * W;
        }
      }
      this.gridScroll = (this.gridScroll + dt * (0.6 + this.warp * 3)) % 1;
    }

    // ───────────────────────── 렌더링 ─────────────────────────

    render(ctx) {
      ctx.save();
      if (this.shake > 0) {
        ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      }
      this.drawBackground(ctx);
      this.drawStars(ctx);
      if (this.state === 'title') {
        this.drawAttract(ctx);
        this.drawParticles(ctx);
      } else {
        this.drawEnemies(ctx);
        this.drawCapsule(ctx);
        this.drawPlayer(ctx);
        this.drawBullets(ctx);
        this.drawParticles(ctx);
        this.drawFloaters(ctx);
        this.drawBanner(ctx);
        this.drawHud(ctx);
      }
      ctx.restore();
    }

    drawBackground(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#03051a');
      g.addColorStop(0.65, '#070b28');
      g.addColorStop(1, '#130a32');
      ctx.fillStyle = g;
      ctx.fillRect(-20, -20, W + 40, H + 40);

      // 원근 네온 그리드 (화면 하단, 은은하게)
      const horizon = H - 140;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 60, 172, 0.1)';
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const k = (i + this.gridScroll) / 7;
        const y = horizon + (H - horizon) * k * k;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      for (let i = -6; i <= 6; i++) {
        ctx.moveTo(W / 2 + i * 18, horizon);
        ctx.lineTo(W / 2 + i * 110, H);
      }
      ctx.stroke();
      const hz = ctx.createLinearGradient(0, 0, W, 0);
      hz.addColorStop(0, 'rgba(60, 240, 255, 0)');
      hz.addColorStop(0.5, 'rgba(60, 240, 255, 0.35)');
      hz.addColorStop(1, 'rgba(60, 240, 255, 0)');
      ctx.strokeStyle = hz;
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(W, horizon);
      ctx.stroke();
      ctx.restore();
    }

    drawStars(ctx) {
      const colors = ['#36406e', '#8792c4', '#ffffff'];
      const streak = this.warp * 18;
      for (const s of this.stars) {
        const tw = 0.6 + 0.4 * Math.sin(this.time * 3 + s.tw);
        ctx.globalAlpha = s.z === 2 ? tw : 0.8;
        ctx.fillStyle = colors[s.z];
        const size = s.z === 2 ? 2 : 1;
        ctx.fillRect(s.x, s.y, size, size + streak * (s.z + 1) * 0.5);
      }
      ctx.globalAlpha = 1;
    }

    drawSprite(ctx, spr, x, y, angle, alpha) {
      if (!spr || !spr.canvas) {
        ctx.fillStyle = COLORS.cyan;
        ctx.fillRect(x - 10, y - 8, 20, 16);
        return;
      }
      if (alpha !== undefined) ctx.globalAlpha = alpha;
      if (angle) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.drawImage(spr.canvas, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
        ctx.restore();
      } else {
        ctx.drawImage(spr.canvas, x - spr.w / 2, y - spr.h / 2, spr.w, spr.h);
      }
      if (alpha !== undefined) ctx.globalAlpha = 1;
    }

    enemySprite(e) {
      const S = this.sprites;
      if (!S) return null;
      const frame = Math.floor(e.anim * 2.5) % 2;
      if (e.flash > 0) return S.flash[e.type][frame];
      const set = e.type === 'warden' && e.hurt ? S.wardenHurt : S[e.type];
      return set[frame];
    }

    drawEnemies(ctx) {
      for (const e of this.enemies) {
        if (e.dead || e.state === 'waiting') continue;
        this.drawSprite(ctx, this.enemySprite(e), e.x, e.y, e.angle);
      }
    }

    drawAttract(ctx) {
      // 타이틀 화면 배경: 편대가 천천히 가로지르는 데모
      if (!this.sprites) return;
      const types = ['warden', 'stinger', 'stinger', 'drone', 'drone', 'drone'];
      for (let i = 0; i < 12; i++) {
        const type = types[i % types.length];
        const x = ((this.time * 38 + i * 61) % (W + 80)) - 40;
        const y = 54 + (i % 3) * 30 + Math.sin(this.time * 1.4 + i) * 10;
        const frame = Math.floor(this.time * 2.5 + i) % 2;
        this.drawSprite(ctx, this.sprites[type][frame], x, y, 0, 0.35);
      }
      const px = W / 2 + Math.sin(this.time * 0.9) * 120;
      this.drawSprite(ctx, this.sprites.player, px, PLAYER_Y, 0, 0.4);
    }

    drawPlayer(ctx) {
      const p = this.player;
      if (!p.alive) return;
      if (p.invuln > 0 && Math.floor(p.invuln * 12) % 2 === 0) return;
      const y = PLAYER_Y;
      // 엔진 불꽃
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flick = 4 + Math.random() * 5;
      ctx.fillStyle = 'rgba(255,122,60,0.8)';
      ctx.fillRect(p.x - 4, y + 11, 3, flick);
      ctx.fillRect(p.x + 1, y + 11, 3, flick);
      ctx.fillStyle = 'rgba(255,210,60,0.9)';
      ctx.fillRect(p.x - 3, y + 11, 1, flick * 0.6);
      ctx.fillRect(p.x + 2, y + 11, 1, flick * 0.6);
      if (p.muzzle > 0) {
        ctx.fillStyle = 'rgba(200,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(p.x, y - 14, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      this.drawSprite(ctx, this.sprites && this.sprites.player, p.x, y, p.tilt * 0.12);
      if (this.twinTimer > 0) {
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.25 * Math.sin(this.time * 10);
        ctx.strokeStyle = COLORS.green;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, y + 1, 19, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawBullets(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of this.playerBullets) {
        ctx.fillStyle = 'rgba(60,240,255,0.35)';
        ctx.fillRect(b.x - 3, b.y - 8, 6, 16);
        ctx.fillStyle = '#eaffff';
        ctx.fillRect(b.x - 1, b.y - 7, 2, 14);
      }
      for (const b of this.enemyBullets) {
        const pulse = 0.7 + 0.3 * Math.sin(b.t * 20);
        ctx.fillStyle = `rgba(255,60,172,${0.35 * pulse})`;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffd9ef';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y - 5);
        ctx.lineTo(b.x + 3, b.y);
        ctx.lineTo(b.x, b.y + 5);
        ctx.lineTo(b.x - 3, b.y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    drawCapsule(ctx) {
      const c = this.capsule;
      if (!c) return;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.sin(c.t * 4) * 0.3);
      ctx.shadowColor = COLORS.green;
      ctx.shadowBlur = 10;
      roundRectPath(ctx, -10, -10, 20, 20, 5);
      ctx.fillStyle = 'rgba(60,255,154,0.2)';
      ctx.fill();
      ctx.strokeStyle = COLORS.green;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#eafff4';
      ctx.font = `800 11px ${FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×2', 0, 1);
      ctx.restore();
    }

    drawParticles(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.particles) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.lineWidth = 2;
      for (const r of this.rings) {
        ctx.globalAlpha = Math.max(0, r.life / r.max) * 0.8;
        ctx.strokeStyle = r.color;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawFloaters(ctx) {
      ctx.save();
      ctx.font = `800 13px ${FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const f of this.floaters) {
        ctx.globalAlpha = Math.max(0, Math.min(1, f.life / f.max * 1.5));
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.restore();
    }

    drawBanner(ctx) {
      const b = this.banner;
      if (!b) return;
      const fadeIn = Math.min(1, b.t / 0.25);
      const fadeOut = Math.min(1, (b.dur - b.t) / 0.4);
      const a = Math.max(0, Math.min(fadeIn, fadeOut));
      const cy = H * 0.52;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 28px ${FONT_UI}`;
      ctx.shadowColor = 'rgba(60, 240, 255, 0.75)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = UI.text;
      ctx.fillText(b.text, W / 2, cy);
      ctx.shadowBlur = 0;
      // 제목과 부제 사이 짧은 네온 구분선
      const rule = ctx.createLinearGradient(W / 2 - 40, 0, W / 2 + 40, 0);
      rule.addColorStop(0, 'rgba(60, 240, 255, 0)');
      rule.addColorStop(0.5, COLORS.cyan);
      rule.addColorStop(1, 'rgba(255, 60, 172, 0)');
      ctx.fillStyle = rule;
      ctx.fillRect(W / 2 - 40, cy + 22, 80, 2);
      if (b.sub) {
        ctx.font = `600 14px ${FONT_UI}`;
        ctx.fillStyle = '#b9c2ea';
        ctx.fillText(b.sub, W / 2, cy + 42);
      }
      ctx.restore();
    }

    hudCard(ctx, x, w, k, label, value, color, align) {
      const y = 10;
      drawCard(ctx, x, y, w, 42 * k);
      const tx = align === 'center' ? x + w / 2 : x + 12 * k;
      ctx.textAlign = align === 'center' ? 'center' : 'left';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${11 * k}px ${FONT_UI}`;
      ctx.fillStyle = UI.label;
      ctx.fillText(label, tx, y + 7 * k);
      ctx.font = `700 ${17 * k}px ${FONT_NUM}`;
      ctx.fillStyle = color;
      ctx.fillText(value, tx, y + 21 * k);
    }

    drawHud(ctx) {
      const k = L.clamp(Number(this.hudScale) || 1, 1, 1.3);
      ctx.save();
      const wide = 112 * k;
      this.hudCard(ctx, 10, wide, k, '점수', L.formatScore(this.score), UI.text, 'left');
      this.hudCard(ctx, W / 2 - wide / 2, wide, k, '최고 점수', L.formatScore(this.highScore), UI.high, 'center');
      this.hudCard(ctx, W - 10 - 84 * k, 84 * k, k, '스테이지', String(this.level), COLORS.cyan, 'left');

      // 남은 생명(현재 기체 제외 예비 기체)
      const reserve = Math.max(0, this.lives - (this.player.alive ? 1 : 0));
      const spr = this.sprites && this.sprites.player;
      for (let i = 0; i < Math.min(reserve, MAX_LIVES); i++) {
        const x = 22 + i * 22;
        if (spr) ctx.drawImage(spr.canvas, x - spr.w * 0.3, H - 22 - spr.h * 0.3, spr.w * 0.6, spr.h * 0.6);
        else {
          ctx.fillStyle = COLORS.cyan;
          ctx.fillRect(x - 6, H - 26, 12, 8);
        }
      }

      if (this.twinTimer > 0) {
        const w = 124 * k;
        const h = 26 * k;
        const x = W - 10 - w;
        const y = H - 10 - h;
        const left = this.twinTimer / TWIN_DURATION;
        drawCard(ctx, x, y, w, h);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${11 * k}px ${FONT_UI}`;
        ctx.fillStyle = COLORS.green;
        ctx.fillText('트윈 샷', x + 10 * k, y + h / 2);
        const bx = x + 58 * k;
        const bw = 56 * k;
        roundRectPath(ctx, bx, y + h / 2 - 3, bw, 6, 3);
        ctx.fillStyle = 'rgba(60, 255, 154, 0.15)';
        ctx.fill();
        roundRectPath(ctx, bx, y + h / 2 - 3, Math.max(6, bw * left), 6, 3);
        ctx.fillStyle = COLORS.green;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  return {
    Game,
    START_LIVES,
    MAX_LIVES,
    TWIN_DURATION,
    GAME_OVER_DELAY,
    LEVEL_CLEAR_DELAY,
  };
});
