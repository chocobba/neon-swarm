#!/usr/bin/env node
/*
 * 실제 브라우저 E2E 스모크 테스트 (선택 사항, 외부 npm 의존성 없음)
 * 헤드리스 Chrome/Chromium을 DevTools 프로토콜로 조작해 index.html을 검증합니다.
 *
 *   node tests/e2e-chrome.mjs                # Chrome 자동 탐색
 *   CHROME_PATH=/path/to/chrome node tests/e2e-chrome.mjs
 *   SCREENSHOT_DIR=./shots node tests/e2e-chrome.mjs   # 스크린샷 저장 위치
 *
 * Chrome을 찾지 못하면 건너뜁니다(종료 코드 0). Node 22 이상 필요(내장 WebSocket).
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = pathToFileURL(join(root, 'index.html')).href;
const shotDir = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : mkdtempSync(join(tmpdir(), 'neon-swarm-shots-'));

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pw = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(pw, d, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      /* 다음 후보 */
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(mac) ? mac : null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIP: Chrome/Chromium을 찾지 못해 E2E 테스트를 건너뜁니다. (CHROME_PATH 지정 가능)');
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.log('SKIP: 이 Node 버전에는 내장 WebSocket이 없습니다 (Node 22+ 필요).');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'neon-swarm-profile-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--window-size=1000,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const timer = setTimeout(() => rej(new Error('Chrome DevTools 시작 시간 초과')), 15000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      res(m[1]);
    }
  });
  chrome.on('exit', (code) => rej(new Error('Chrome exited: ' + code)));
});

const port = new URL(wsUrl).port;
let pageTarget = null;
for (let i = 0; i < 50 && !pageTarget; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  pageTarget = targets.find((t) => t.type === 'page');
  if (!pageTarget) await sleep(100);
}
if (!pageTarget) {
  chrome.kill('SIGKILL');
  throw new Error('Chrome 페이지 대상을 찾지 못했습니다');
}
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let msgId = 0;
const pending = new Map();
const errors = [];
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
  }
  listeners.forEach((fn) => fn(msg));
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + expr + ' → ' + r.exceptionDetails.text);
  return r.result.value;
};
const waitLoad = () =>
  new Promise((res) => {
    const fn = (m) => {
      if (m.method === 'Page.loadEventFired') {
        listeners.splice(listeners.indexOf(fn), 1);
        res();
      }
    };
    listeners.push(fn);
  });
const KEYS = {
  Space: { key: ' ', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', keyCode: 39 },
  KeyP: { key: 'p', keyCode: 80 },
  KeyM: { key: 'm', keyCode: 77 },
  Escape: { key: 'Escape', keyCode: 27 },
  Enter: { key: 'Enter', keyCode: 13, text: '\r' },
};
const key = (type, code) =>
  send('Input.dispatchKeyEvent', {
    type,
    code,
    key: KEYS[code].key,
    windowsVirtualKeyCode: KEYS[code].keyCode,
    ...(type === 'keyDown' && KEYS[code].text ? { text: KEYS[code].text } : {}),
  });
const tap = async (code) => {
  await key('keyDown', code);
  await key('keyUp', code);
};
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(shotDir, { recursive: true });
  const file = join(shotDir, name + '.png');
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};
const state = () => evaluate('window.__neonSwarm.game.state');
const active = () => evaluate('document.activeElement && document.activeElement.id');

// 현재 화면의 레이아웃 문제(잘림·겹침·화면 밖 배치)를 수집
const LAYOUT_AUDIT = `(() => {
  const issues = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const vw = innerWidth, vh = innerHeight;
  const screen = document.getElementById('screen').getBoundingClientRect();
  if (screen.left < -1 || screen.top < -1 || screen.right > vw + 1 || screen.bottom > vh + 1) issues.push('screen outside viewport');
  // 상단 바는 가로 모드에서 모서리에 떠 있으므로, 실제로 보이는 브랜드·버튼만 겹침 검사
  for (const el of document.querySelectorAll('.brand, .icon-btn')) {
    if (vis(el) && hit(el.getBoundingClientRect(), screen)) issues.push('topbar item overlaps screen: ' + (el.id || el.className));
  }
  for (const b of document.querySelectorAll('.icon-btn')) {
    const r = b.getBoundingClientRect();
    if (r.height > 48) issues.push('topbar button wraps: ' + b.id);
    if (r.right > vw + 1 || r.left < -1) issues.push('topbar button off-screen: ' + b.id);
  }
  for (const b of document.querySelectorAll('.touch-btn')) {
    if (!vis(b)) continue;
    const r = b.getBoundingClientRect();
    if (hit(r, screen)) issues.push('touch button overlaps screen: ' + b.dataset.action);
    if (r.left < -1 || r.right > vw + 1 || r.bottom > vh + 1 || r.top < -1) issues.push('touch button off-screen: ' + b.dataset.action);
    if (r.height < 44 || r.width < 44) issues.push('touch target too small: ' + b.dataset.action);
  }
  const ov = [...document.querySelectorAll('.overlay')].find((o) => !o.hidden);
  if (ov) {
    if (ov.scrollHeight > ov.clientHeight + 2) issues.push(ov.id + ' content overflows vertically (' + ov.scrollHeight + '>' + ov.clientHeight + ')');
    const box = ov.getBoundingClientRect();
    for (const el of ov.querySelectorAll('*')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) issues.push(ov.id + ' horizontal clip: ' + (el.id || el.className || el.tagName));
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0 && el.children.length === 0)
        issues.push(ov.id + ' text overflow: ' + (el.id || el.className || el.tagName));
    }
  }
  return issues;
})()`;
const auditLayout = async (label) => {
  const issues = await evaluate(LAYOUT_AUDIT);
  check(issues.length === 0, `레이아웃: ${label}` + (issues.length ? ' → ' + issues.join('; ') : ''));
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  console.log('▶ 데스크톱 (1000×900)');
  let loaded = waitLoad();
  await send('Page.navigate', { url: pageUrl });
  await loaded;
  await sleep(500);

  check((await state()) === 'title', '타이틀 상태로 시작');
  check((await active()) === 'btn-start', '시작 버튼에 초기 포커스');
  check(await evaluate('!document.getElementById("overlay-title").hidden'), '타이틀 오버레이 표시');
  check(await evaluate('document.getElementById("btn-pause").disabled'), '타이틀에서는 일시정지 버튼 비활성');
  const layout = await evaluate(`(() => { const r = document.getElementById('screen').getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, vh: innerHeight, vw: innerWidth }; })()`);
  check(layout.bottom <= layout.vh && layout.w <= layout.vw && Math.abs(layout.w / layout.h - 0.75) < 0.01, `게임 화면이 뷰포트 안에 3:4 비율로 배치 (${Math.round(layout.w)}×${Math.round(layout.h)})`);
  await auditLayout('데스크톱 타이틀');
  console.log('    스크린샷:', await screenshot('1-title-desktop'));

  await tap('Enter'); // 포커스된 시작 버튼 활성화
  await sleep(300);
  check((await state()) === 'playing', 'Enter로 게임 시작');
  check((await active()) === 'game', '플레이 중에는 캔버스에 포커스');
  check(await evaluate('document.getElementById("overlay-title").hidden'), '타이틀 오버레이 숨김');

  const x0 = await evaluate('window.__neonSwarm.game.player.x');
  await key('rawKeyDown', 'ArrowRight');
  await sleep(400);
  await key('keyUp', 'ArrowRight');
  const x1 = await evaluate('window.__neonSwarm.game.player.x');
  check(x1 > x0 + 20, `→ 키로 오른쪽 이동 (${x0.toFixed(0)} → ${x1.toFixed(0)})`);
  await key('rawKeyDown', 'ArrowLeft');
  await sleep(400);
  await key('keyUp', 'ArrowLeft');
  check((await evaluate('window.__neonSwarm.game.player.x')) < x1 - 20, '← 키로 왼쪽 이동');

  await evaluate('window.__neonSwarm.game.player.invuln = 999');
  await key('rawKeyDown', 'Space');
  await sleep(1200);
  await key('keyUp', 'Space');
  check((await evaluate('window.__neonSwarm.game.stats.shots')) >= 3, 'Space 누르고 있으면 연사');
  await sleep(5000);
  check((await evaluate('window.__neonSwarm.game.enemies.filter(e => e.state !== "waiting").length')) > 10, '적 편대가 입장');
  await auditLayout('데스크톱 플레이');
  console.log('    스크린샷:', await screenshot('2-gameplay-desktop'));

  await tap('KeyP');
  await sleep(200);
  check((await state()) === 'paused', 'P 키로 일시정지');
  check((await active()) === 'btn-resume', '일시정지 시 계속하기 버튼에 포커스');
  check((await evaluate('document.getElementById("btn-pause").getAttribute("aria-pressed")')) === 'true', '일시정지 버튼 aria-pressed=true');
  const t0 = await evaluate('window.__neonSwarm.game.time');
  await sleep(400);
  check((await evaluate('window.__neonSwarm.game.time')) === t0, '일시정지 중에는 게임 시간이 멈춤');
  await auditLayout('데스크톱 일시정지');
  console.log('    스크린샷:', await screenshot('3-paused'));
  await tap('Escape');
  await sleep(200);
  check((await state()) === 'playing', 'Esc로 재개');

  await tap('KeyM');
  await sleep(100);
  check((await evaluate('document.getElementById("btn-mute").getAttribute("aria-pressed")')) === 'true', 'M 키로 음소거 (aria-pressed)');
  check((await evaluate('localStorage.getItem("neonSwarm.muted")')) === '1', '음소거 설정 저장');
  check(await evaluate('window.__neonSwarm.audio.ctx !== null'), '사용자 입력 후 AudioContext 생성');
  // play()는 오류를 삼키므로 합성 함수들을 직접 호출해 실제 Web Audio에서 예외가 없는지 확인
  const synth = await evaluate(`(() => { try { const a = window.__neonSwarm.audio;
    a.tone({ type: 'square', f0: 880, f1: 220, dur: 0.05, vol: 0.01 });
    a.noise({ dur: 0.05, vol: 0.01, freq: 3000, freqEnd: 100 });
    a.melody([440, 660], 0.03, 'triangle', 0.01);
    return 'ok'; } catch (e) { return String(e); } })()`);
  check(synth === 'ok', `Web Audio 합성 함수 동작 (${synth})`);
  await tap('KeyM');

  // 게임 오버 흐름 — Space를 누른 채 죽어도 '다시 하기'가 즉시 눌리지 않아야 함
  await evaluate('(() => { const g = window.__neonSwarm.game; g.score = 31337; g.lives = 1; g.player.invuln = 0; g.killPlayer(); })()');
  await key('rawKeyDown', 'Space');
  await sleep(3200);
  check((await state()) === 'gameover', '마지막 생명을 잃으면 게임 오버');
  check((await active()) !== 'btn-retry', 'Space를 누르고 있는 동안에는 포커스를 옮기지 않음');
  await key('keyUp', 'Space');
  await sleep(300);
  check((await state()) === 'gameover', 'Space를 떼도 자동 재시작되지 않음');
  check((await active()) === 'btn-retry', '키를 놓은 뒤 다시 하기 버튼에 포커스');
  check((await evaluate('localStorage.getItem("neonSwarm.highScore")')) === '31337', '최고 점수 localStorage 저장');
  check(await evaluate('!document.getElementById("new-record").hidden'), '신기록 표시');
  check((await evaluate('document.getElementById("go-score").textContent')) === '31,337', '게임 오버 점수 표시');
  await auditLayout('데스크톱 게임 오버');
  console.log('    스크린샷:', await screenshot('4-gameover'));

  await tap('Enter');
  await sleep(300);
  check((await state()) === 'playing', '다시 하기로 재시작');
  check((await evaluate('window.__neonSwarm.game.score')) === 0, '재시작 시 점수 초기화');

  // 모바일 레이아웃 + 터치
  console.log('▶ 모바일 (390×844, 터치)');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  loaded = waitLoad();
  await send('Page.reload', { ignoreCache: true });
  await loaded;
  await sleep(500);
  check((await evaluate('document.getElementById("title-high").textContent')) === '031337', '새로고침 후 최고 점수 유지');
  check(await evaluate('getComputedStyle(document.getElementById("touch-controls")).display !== "none"'), '터치 조작 버튼 표시');
  const m = await evaluate(`(() => { const s = document.getElementById('screen').getBoundingClientRect();
    const t = document.getElementById('touch-controls').getBoundingClientRect();
    return { sw: s.width, sb: s.bottom, tt: t.top, tb: t.bottom, vh: innerHeight, vw: innerWidth }; })()`);
  check(m.sw <= m.vw && m.sb <= m.tt + 1 && m.tb <= m.vh + 1, `게임 화면과 터치 버튼이 겹치지 않고 화면 안에 배치 (화면 폭 ${Math.round(m.sw)}px)`);
  const titleScroll = await evaluate(`(() => { const o = document.getElementById('overlay-title'); return o.scrollHeight <= o.clientHeight + 2; })()`);
  check(titleScroll, '모바일 타이틀 화면 내용이 잘리지 않음');
  await auditLayout('모바일 세로 타이틀');
  console.log('    스크린샷:', await screenshot('5-title-mobile'));

  await evaluate('document.getElementById("btn-start").click()');
  await sleep(200);
  const fireBtn = await evaluate(`(() => { const r = document.querySelector('.touch-btn.fire').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const rightBtn = await evaluate(`(() => { const r = document.querySelector('.touch-btn[data-action=right]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const px0 = await evaluate('window.__neonSwarm.game.player.x');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rightBtn.x, y: rightBtn.y, id: 1 }, { x: fireBtn.x, y: fireBtn.y, id: 2 }] });
  await sleep(500);
  check(await evaluate('window.__neonSwarm.game.input.right && window.__neonSwarm.game.input.fire'), '멀티 터치: 이동+발사 동시 입력');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  check((await evaluate('window.__neonSwarm.game.player.x')) > px0 + 20, '터치 ▶ 버튼으로 이동');
  check((await evaluate('window.__neonSwarm.game.stats.shots')) >= 1, '터치 발사 버튼으로 사격');
  check(!(await evaluate('window.__neonSwarm.game.input.right || window.__neonSwarm.game.input.fire')), '손을 떼면 입력 해제');
  await sleep(4000);
  await auditLayout('모바일 세로 플레이');
  console.log('    스크린샷:', await screenshot('6-gameplay-mobile'));
  await evaluate('(() => { const g = window.__neonSwarm.game; g.score = 1200; g.lives = 1; g.player.invuln = 0; g.killPlayer(); })()');
  await sleep(3200);
  check((await state()) === 'gameover', '모바일 게임 오버 화면');
  await auditLayout('모바일 세로 게임 오버');
  console.log('    스크린샷:', await screenshot('6b-gameover-mobile'));

  const topbar = await evaluate(`[...document.querySelectorAll('.icon-btn')].map(b => ({ h: b.getBoundingClientRect().height, name: b.textContent.trim() }))`);
  check(topbar.every((b) => b.h <= 52 && b.name.length > 0), '상단 버튼이 한 줄로 표시되고 접근 가능한 이름 유지');

  console.log('▶ 모바일 가로 (844×390)');
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await sleep(400);
  const land = await evaluate(`document.getElementById('screen').getBoundingClientRect().height`);
  check(land > 250, `가로 모드 게임 화면 높이 확보 (${Math.round(land)}px)`);
  await auditLayout('모바일 가로 게임 오버');
  console.log('    스크린샷:', await screenshot('7a-gameover-landscape'));
  await evaluate('window.__neonSwarm.game.quitToTitle()');
  await sleep(300);
  await auditLayout('모바일 가로 타이틀');
  console.log('    스크린샷:', await screenshot('7b-title-landscape'));
  await evaluate('document.getElementById("btn-start").click()');
  await sleep(4000);
  await auditLayout('모바일 가로 플레이');
  console.log('    스크린샷:', await screenshot('7-landscape-mobile'));

  console.log('▶ 작은 가로 화면 (667×375)');
  await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await auditLayout('작은 가로 플레이');
  await evaluate('window.__neonSwarm.game.quitToTitle()');
  await sleep(300);
  await auditLayout('작은 가로 타이틀');
  console.log('    스크린샷:', await screenshot('8-title-landscape-small'));

  check(errors.length === 0, '콘솔 오류/예외 없음' + (errors.length ? ':\n      ' + errors.join('\n      ') : ''));
} catch (e) {
  failures++;
  console.error('E2E 실행 오류:', e);
} finally {
  ws.close();
  chrome.kill('SIGKILL');
  await sleep(200);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 무시 */
  }
}

console.log(failures ? `\nE2E 실패: ${failures}건` : '\nE2E 통과');
console.log('스크린샷 폴더:', shotDir);
process.exit(failures ? 1 : 0);
