'use strict';

/* =========================================================================
 * 哥俩好 · 无尽模式 · 客户端
 *  - 只负责：上报按键、渲染服务端广播的状态、UI 界面
 *  - 所有物理计算在服务端，客户端做位置插值让画面顺滑
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 状态
const App = {
  ws: null,
  connected: false,
  mySlot: 0,
  isHost: false,
  roomCode: '',
  screen: 'home',

  // 关卡元信息（尺寸常量）+ 动态几何（平台/尖刺/金币）
  level: null,
  world: { platforms: [], hazards: [], coins: [] },
  hasState: false,

  roomBest: null,
  localBest: Number(localStorage.getItem('glh_best') || 0),
  names: [],                       // 两名玩家的昵称（画在头顶）

  net: {
    players: [
      { x: 0, y: 0, vx: 0, vy: 0, facing: 1, dead: false, grounded: true, invuln: false, rescuing: false, rescue: 0 },
      { x: 0, y: 0, vx: 0, vy: 0, facing: 1, dead: false, grounded: true, invuln: false, rescuing: false, rescue: 0 },
    ],
    time: 0, lives: 3, phase: 'countdown', timer: 3,
    score: 0, coins: 0, wallX: -600, lastDeath: null,
  },

  pos: [
    { x: 0, y: 0, facing: 1, dead: false, sy: 1, rescuing: false, rescue: 0 },
    { x: 0, y: 0, facing: 1, dead: false, sy: 1, rescuing: false, rescue: 0 },
  ],
  cam: { x: 200, y: 400, scale: 1, init: false },
  particles: [],
  lastOverlayKey: '',
};

// ------------------------------------------------------------------ 音效
const Sound = {
  ctx: null, on: true,
  init() {
    if (this.ctx) return;
    try { const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC(); } catch (_) { this.ctx = null; }
  },
  tone(freq, dur, type = 'sine', vol = 0.14, delay = 0, slideTo = null) {
    if (!this.on || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },
  jump() { this.tone(360, 0.14, 'square', 0.10, 0, 620); },
  coin() { this.tone(1180, 0.07, 'square', 0.07); this.tone(1560, 0.09, 'square', 0.06, 0.05); },
  death() { this.tone(320, 0.45, 'sawtooth', 0.14, 0, 90); },
  respawn() { this.tone(420, 0.1, 'sine', 0.1); this.tone(620, 0.12, 'sine', 0.1, 0.08); },
  tick() { this.tone(840, 0.07, 'sine', 0.08); },
  go() { this.tone(660, 0.1, 'square', 0.12); this.tone(990, 0.18, 'square', 0.12, 0.09); },
  gameover() { [400, 300, 200].forEach((f, i) => this.tone(f, 0.3, 'sawtooth', 0.12, i * 0.16)); },
};

// ------------------------------------------------------------------ 网络
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}

function connect() {
  if (App.ws && (App.ws.readyState === 0 || App.ws.readyState === 1)) return;
  const ws = new WebSocket(wsURL());
  App.ws = ws;
  ws.onopen = () => { App.connected = true; };
  ws.onclose = () => {
    App.connected = false;
    if (App.screen !== 'home') { toast('与服务器断开连接'); setTimeout(() => goHome(), 400); }
    setTimeout(connect, 1500);
  };
  ws.onerror = () => { toast('无法连接服务器'); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onMessage(m); };
}

function send(obj) {
  if (App.ws && App.ws.readyState === 1) App.ws.send(JSON.stringify(obj));
}

// ------------------------------------------------------------------ 界面
function showScreen(name) {
  App.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $('screen-' + name).classList.add('active');
  if (name === 'game') resizeCanvas();
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function goHome() {
  send({ t: 'leave' });
  App.roomCode = '';
  App.level = null;
  App.world = { platforms: [], hazards: [], coins: [] };
  App.hasState = false;
  App.cam.init = false;
  App.roomBest = null;
  setOverlay('');
  showScreen('home');
}

// ------------------------------------------------------------------ 消息处理
function onMessage(m) {
  switch (m.t) {
    case 'created':
      App.mySlot = m.slot; App.roomCode = m.code; App.isHost = true;
      localStorage.setItem('glh_code', m.code);
      showScreen('room'); updateRoomUI();
      break;
    case 'joined':
      App.mySlot = m.slot; App.roomCode = m.code;
      localStorage.setItem('glh_code', m.code);
      showScreen('room');
      break;
    case 'room':
      App.roomCode = m.code;
      App.isHost = (m.host === App.mySlot);
      App.roomInfo = m;
      if (typeof m.best === 'number') App.roomBest = m.best;
      if (App.screen === 'game' && m.phase === 'lobby') {
        App.level = null; App.hasState = false; App.cam.init = false;
        keys.left = keys.right = keys.jump = false;
        setOverlay(''); showScreen('room'); toast('对局已中断');
      }
      if (App.screen !== 'game') updateRoomUI();
      break;
    case 'level':
      startGameScreen(m.level);
      break;
    case 'world':
      App.world = { platforms: m.platforms || [], hazards: m.hazards || [], coins: m.coins || [] };
      break;
    case 'started':
      setOverlay('');
      break;
    case 'state':
      onState(m);
      break;
    case 'go':
      Sound.go();
      break;
    case 'death':
      Sound.death();
      spawnBurst(App.pos[0], '#ff6b6b'); spawnBurst(App.pos[1], '#ff6b6b');
      break;
    case 'respawn':
      Sound.respawn();
      break;
    case 'gameover':
      if (typeof m.best === 'number') App.roomBest = m.best;
      if (typeof m.score === 'number' && m.score > App.localBest) {
        App.localBest = m.score;
        localStorage.setItem('glh_best', String(m.score));
      }
      Sound.gameover();
      break;
    case 'peerLeft':
      toast('队友离开了房间');
      if (App.screen === 'game') {
        App.level = null; App.hasState = false; App.cam.init = false;
        keys.left = keys.right = keys.jump = false;
        setOverlay(''); showScreen('room');
      }
      break;
    case 'error':
      toast(m.msg || '出错了');
      break;
  }
}

function updateRoomUI() {
  $('roomCode').textContent = App.roomCode;
  const players = (App.roomInfo && App.roomInfo.players) || [];
  for (let i = 0; i < 2; i++) {
    const slot = players[i];
    const el = $('slot' + i);
    const nameEl = el.querySelector('.slot-name');
    const joined = slot && slot.connected && slot.name;
    if (joined) { el.classList.remove('empty'); nameEl.textContent = slot.name + (i === App.mySlot ? '（你）' : ''); }
    else { el.classList.add('empty'); nameEl.textContent = i === 0 ? '等待中…' : '等待加入…'; }
    el.classList.toggle('self', i === App.mySlot);
  }
  const both = players.filter((p) => p && p.connected && p.name).length === 2;
  $('btnStart').disabled = !(App.isHost && both);
  $('roomHint').textContent = App.isHost
    ? (both ? '准备好了，点击开始！' : '等待好兄弟加入…')
    : '等待房主开始游戏…';
  $('roomBest').textContent = (App.roomBest != null) ? '本房间最佳成绩：' + App.roomBest + ' 分' : '';
}

// ------------------------------------------------------------------ 游戏
function startGameScreen(level) {
  App.level = level;
  const roomNames = ((App.roomInfo && App.roomInfo.players) || []).map((p) => (p ? p.name : ''));
  App.names = (level.names && level.names.some(Boolean)) ? level.names.slice(0, 2) : roomNames;
  App.world = { platforms: [], hazards: [], coins: [] };
  App.hasState = false;
  App.cam.init = false;
  App.particles.length = 0;
  App.lastOverlayKey = '';
  App.coinsSeen = 0;
  const sx0 = 200;
  for (let i = 0; i < 2; i++) {
    const x = sx0 + (i === 0 ? -30 : 30);
    App.pos[i] = { x, y: level.groundY - level.playerH / 2, facing: 1, dead: false, sy: 1 };
    App.net.players[i] = { x, y: level.groundY - level.playerH / 2, vx: 0, vy: 0, facing: 1, dead: false, grounded: true, invuln: false };
  }
  App.net.phase = 'countdown'; App.net.timer = 3;
  App.net.lives = 3; App.net.time = 0; App.net.score = 0; App.net.coins = 0; App.net.wallX = -600;
  setOverlay('');
  showScreen('game');
}

function onState(m) {
  const prevPhase = App.net.phase;
  App.hasState = true;
  App.net.time = m.time;
  App.net.lives = m.lives;
  App.net.phase = m.phase;
  App.net.timer = m.timer;
  App.net.score = m.score;
  App.net.coins = m.coins;
  App.net.wallX = m.wallX;
  App.net.lastDeath = m.lastDeath;
  if (m.coins > (App.coinsSeen || 0)) Sound.coin();
  App.coinsSeen = m.coins;
  for (let i = 0; i < 2; i++) App.net.players[i] = m.players[i];
  updateHud();
  updateOverlay();
  if (prevPhase !== m.phase && m.phase === 'play' && prevPhase === 'countdown') Sound.go();
}

// ------------------------------------------------------------------ HUD
function updateHud() {
  const lives = $('lives');
  let html = '';
  for (let i = 0; i < 3; i++) html += `<span class="${i < App.net.lives ? '' : 'dead'}">❤️</span>`;
  lives.innerHTML = html;

  $('score').textContent = App.net.score;
  $('bestScore').textContent = Math.max(App.localBest, App.roomBest || 0);
  $('coins').textContent = App.net.coins;
  $('timer').textContent = App.net.time.toFixed(1) + '″';

  // 危险提示：岩浆墙逼近
  const near = Math.min(App.pos[0].x - App.net.wallX, App.pos[1].x - App.net.wallX);
  $('danger').classList.toggle('on', App.net.phase === 'play' && near < 300);
}

function setOverlay(kind, data) {
  const el = $('overlay');
  if (!kind) { el.classList.remove('show'); el.innerHTML = ''; return; }
  let html = '';
  if (kind === 'countdown') {
    const n = Math.ceil(data.timer);
    html = `<div class="big">${n > 0 ? n : 'GO'}</div><div class="sub">躲开岩浆，往前冲！</div>`;
  } else if (kind === 'dead') {
    const r = data.reason === 'spike' ? '踩到尖刺了 😖' : data.reason === 'wall' ? '被岩浆追上了 🔥' : '掉下去了 😵';
    html = `<div class="big small text-bad">重来！</div><div class="sub">${r}　还剩 ${data.lives} 条命</div>`;
  } else if (kind === 'gameover') {
    const best = Math.max(App.localBest, App.roomBest || 0);
    html = `<div class="big small text-bad">游戏结束</div>
      <div class="sub">本局 <b>${data.score}</b> 分　·　🪙 ${data.coins}</div>
      <div class="sub">最佳成绩 <b>${best}</b> 分</div>
      <div class="actions">
        <button class="btn btn-primary" id="ovRematch">再来一局</button>
        <button class="btn btn-ghost" id="ovHome">返回大厅</button>
      </div>`;
  }
  el.innerHTML = html;
  el.classList.add('show');
  const rb = $('ovRematch'); if (rb) rb.onclick = () => send({ t: 'rematch' });
  const hb = $('ovHome'); if (hb) hb.onclick = () => goHome();
}

function updateOverlay() {
  const ph = App.net.phase;
  let kind = '';
  if (ph === 'countdown') kind = 'countdown';
  else if (ph === 'dead') kind = 'dead';
  else if (ph === 'gameover') kind = 'gameover';

  const key = kind + '|' + (kind === 'countdown' ? Math.ceil(App.net.timer) : '') +
    '|' + (kind === 'dead' ? App.net.lives + App.net.lastDeath : '') +
    '|' + (kind === 'gameover' ? App.net.score : '');
  if (key === App.lastOverlayKey) return;
  App.lastOverlayKey = key;

  if (kind === 'countdown') setOverlay('countdown', { timer: App.net.timer });
  else if (kind === 'dead') setOverlay('dead', { reason: App.net.lastDeath, lives: App.net.lives });
  else if (kind === 'gameover') setOverlay('gameover', { score: App.net.score, coins: App.net.coins });
  else setOverlay('');
}

// ------------------------------------------------------------------ 输入
const keys = { left: false, right: false, jump: false };

function computeKeys(e, down) {
  switch (e.code) {
    case 'ArrowLeft': case 'KeyA': keys.left = down; return true;
    case 'ArrowRight': case 'KeyD': keys.right = down; return true;
    case 'ArrowUp': case 'KeyW': case 'Space':
      if (down && !keys.jump) Sound.jump();
      keys.jump = down; return true;
  }
  return false;
}

window.addEventListener('keydown', (e) => {
  Sound.init();
  if (App.screen !== 'game') return;
  if (e.repeat) { if (computeKeys(e, true)) e.preventDefault(); return; }
  if (computeKeys(e, true)) { e.preventDefault(); pushInput(); }
});
window.addEventListener('keyup', (e) => {
  if (App.screen !== 'game') return;
  if (computeKeys(e, false)) { e.preventDefault(); pushInput(); }
});

let lastSent = '';
function pushInput() {
  const cur = JSON.stringify(keys);
  if (cur === lastSent) return;
  lastSent = cur;
  send({ t: 'input', left: keys.left, right: keys.right, jump: keys.jump });
}
setInterval(() => { if (App.screen === 'game') pushInput(); lastSent = ''; }, 300);

function bindTouch() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const btn of document.querySelectorAll('.tbtn')) {
    const k = btn.dataset.k;
    let down = false;
    // 状态没变就不改 class，避免多余的样式重算
    const set = (v) => {
      if (v === down) return;
      down = v;
      Sound.init();
      keys[k] = v;
      btn.classList.toggle('active', v);
      pushInput();
    };
    btn.addEventListener('pointerdown', (e) => {
      stop(e);
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      set(true);
    });
    btn.addEventListener('pointerup', (e) => { stop(e); set(false); });
    btn.addEventListener('pointercancel', () => set(false));
    btn.addEventListener('lostpointercapture', () => set(false));
    // 触摸端再兜一层，杜绝浏览器默认手势（滚动/缩放/长按菜单）
    btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches || 'ontouchstart' in window;
  if (coarse) $('touchControls').classList.add('show');
}

// ------------------------------------------------------------------ 粒子
function spawnBurst(p, color) {
  for (let i = 0; i < 14; i++) {
    App.particles.push({
      x: p.x, y: p.y, vx: (Math.random() - 0.5) * 320, vy: -Math.random() * 320 - 60,
      life: 0.7, max: 0.7, color, size: 4 + Math.random() * 5,
    });
  }
}
function updateParticles(dt) {
  for (let i = App.particles.length - 1; i >= 0; i--) {
    const pt = App.particles[i];
    pt.life -= dt;
    if (pt.life <= 0) { App.particles.splice(i, 1); continue; }
    pt.vy += (pt.grav || 900) * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
  }
}

// ------------------------------------------------------------------ 画布
const canvas = $('game');
const ctx = canvas.getContext('2d');

// 玩家形象贴图（已抠好背景的 PNG，按原角色大小等比缩放）
const playerSprites = [new Image(), new Image()];
playerSprites[0].src = 'assets/player0.png';
playerSprites[1].src = 'assets/player1.png';
let W = 0, H = 0, DPR = 1;

function resizeCanvas(force) {
  const nw = window.innerWidth, nh = window.innerHeight;
  const nd = Math.min(window.devicePixelRatio || 1, 2);
  // 尺寸没变化就不要重设 canvas.width/height —— 重设会清空画布，看起来就是闪一下
  if (!force && nw === W && nh === H && nd === DPR) return;
  DPR = nd; W = nw; H = nh;
  canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
}
window.addEventListener('resize', () => { if (App.screen === 'game') resizeCanvas(); });

const sx = (wx) => (wx - App.cam.x) * App.cam.scale + W / 2;
const sy = (wy) => (wy - App.cam.y) * App.cam.scale + H / 2;

// ------------------------------------------------------------------ 主循环
let lastT = performance.now();
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (App.screen === 'game' && App.level) {
    updatePositions(dt);
    updateCamera(dt);
    updateParticles(dt);
    draw();
    updateHud();
  }
  requestAnimationFrame(frame);
}

function updatePositions(dt) {
  const a = 1 - Math.exp(-dt / 0.045);
  for (let i = 0; i < 2; i++) {
    const t = App.net.players[i], p = App.pos[i];
    p.x += (t.x - p.x) * a;
    p.y += (t.y - p.y) * a;
    if (Math.abs(t.x - p.x) < 0.5) p.x = t.x;
    if (Math.abs(t.y - p.y) < 0.5) p.y = t.y;
    p.facing = t.facing; p.dead = t.dead; p.invuln = t.invuln;
    p.rescuing = t.rescuing; p.rescue = t.rescue;
    const targetSy = t.grounded ? 1 : (t.vy < -50 ? 1.08 : 0.94);
    p.sy += (targetSy - p.sy) * Math.min(1, dt * 12);
  }
}

function updateCamera(dt) {
  const p0 = App.pos[0], p1 = App.pos[1];
  const midX = (p0.x + p1.x) / 2;
  const midY = (p0.y + p1.y) / 2 - 70;
  const spanX = Math.abs(p0.x - p1.x) + 700;
  const spanY = Math.abs(p0.y - p1.y) + 380;
  const fit = Math.min(W / spanX, H / spanY);
  const scale = Math.max(H / 1500, Math.min(fit, H / 620));
  const halfH = H / (2 * scale);
  const cx = midX;
  const cy = Math.max(halfH - 320, Math.min(1000 - halfH - 40, midY));

  if (!App.cam.init) { App.cam = { x: cx, y: cy, scale, init: true }; return; }
  const k = Math.min(1, dt * 6);
  App.cam.x += (cx - App.cam.x) * k;
  App.cam.y += (cy - App.cam.y) * k;
  App.cam.scale += (scale - App.cam.scale) * Math.min(1, dt * 4);
}

// ------------------------------------------------------------------ 绘制
function draw() {
  const L = App.level;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSky();
  drawHills();

  const s = App.cam.scale;

  // 平台
  for (const pl of App.world.platforms) {
    const x = sx(pl.x), y = sy(pl.y), w = pl.w * s, h = pl.h * s;
    if (x + w < -40 || x > W + 40) continue;
    drawPlatform(x, y, w, h);
  }

  // 尖刺
  for (const hz of App.world.hazards) {
    const x = sx(hz.x), y = sy(hz.y), w = hz.w * s, h = hz.h * s;
    if (x + w < -40 || x > W + 40) continue;
    drawSpikes(x, y, w, h);
  }

  // 金币
  drawCoins();

  // 岩浆墙
  drawWall();

  // 绳子
  drawRope();

  // 玩家
  drawPlayer(0);
  drawPlayer(1);

  // 粒子
  drawParticles();

  // 救援提示
  drawRescueHint();
}

function drawRescueHint() {
  if (!(App.pos[0].rescuing || App.pos[1].rescuing)) return;
  const msg = '↑ 队友掉坑了，站住别跳，用绳子拉他上来！';
  ctx.save();
  ctx.font = '700 15px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const tw = ctx.measureText(msg).width + 28;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(W / 2 - tw / 2, H * 0.15, tw, 32, 16); ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.fillText(msg, W / 2, H * 0.15 + 8);
  ctx.restore();
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#7fc4ff');
  g.addColorStop(0.6, '#cfe8ff');
  g.addColorStop(1, '#ffe6c2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 太阳
  ctx.save();
  ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff3b0';
  ctx.beginPath(); ctx.arc(W * 0.84, H * 0.15, 44, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.22;
  ctx.beginPath(); ctx.arc(W * 0.84, H * 0.15, 70, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // 火山灰（越靠左越浓，暗示岩浆方向）
  const wx = sx(App.net.wallX);
  if (wx > -700 && wx < W + 200) {
    const gx = Math.max(0, wx);
    const smoke = ctx.createLinearGradient(0, 0, gx + 260, 0);
    smoke.addColorStop(0, 'rgba(60,30,20,0.35)');
    smoke.addColorStop(1, 'rgba(60,30,20,0)');
    ctx.fillStyle = smoke;
    ctx.fillRect(0, 0, gx + 260, H);
  }
}

function drawHills() {
  const base = sy(700);
  ctx.save();
  ctx.globalAlpha = 0.5; ctx.fillStyle = '#8fd0a8';
  const off = App.cam.x * 0.3;
  ctx.beginPath();
  ctx.moveTo(-100, H);
  for (let i = -1; i < 12; i++) {
    const bx = i * 420 - (((off % 420) + 420) % 420);
    ctx.lineTo(bx + 210, base - 150);
    ctx.lineTo(bx + 420, base);
  }
  ctx.lineTo(W + 100, H);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawPlatform(x, y, w, h) {
  const r = Math.min(10, w / 2, h / 2);
  const s = App.cam.scale;
  const grassH = Math.max(12, 20 * s);
  const bandH = Math.min(h, Math.max(46, 80 * s));
  ctx.fillStyle = '#6f4322'; roundRect(x, y, w, h, r); ctx.fill();
  ctx.fillStyle = '#a9683c'; roundRect(x, y, w, bandH, r); ctx.fill();
  ctx.fillStyle = '#5ec26a'; roundRect(x, y, w, grassH, r); ctx.fill();
  ctx.fillStyle = '#79db85'; roundRect(x, y, w, Math.max(5, 7 * s), r); ctx.fill();
}

function drawSpikes(x, y, w, h) {
  const s = App.cam.scale;
  const n = Math.max(1, Math.round(w / (14 * s)));
  const step = w / n;
  ctx.fillStyle = '#dfe8f2'; ctx.strokeStyle = '#8aa0b8'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    ctx.moveTo(x + i * step, y + h);
    ctx.lineTo(x + (i + 0.5) * step, y);
    ctx.lineTo(x + (i + 1) * step, y + h);
  }
  ctx.fill(); ctx.stroke();
}

function drawCoins() {
  const s = App.cam.scale;
  const bob = Math.sin(performance.now() / 300) * 3 * s;
  for (const c of App.world.coins) {
    const x = sx(c.x), y = sy(c.y) + bob;
    if (x < -30 || x > W + 30) continue;
    const r = 12 * s;
    ctx.save();
    ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 12 * s;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#e0a800';
    ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath(); ctx.arc(x - r * 0.28, y - r * 0.3, r * 0.22, 0, Math.PI * 2); ctx.fill();
  }
}

function drawWall() {
  const s = App.cam.scale;
  const wx = sx(App.net.wallX);
  if (wx < -260) return;
  const w = Math.max(0, wx);
  // 主体
  const g = ctx.createLinearGradient(w - 200, 0, w, 0);
  g.addColorStop(0, '#3a0808');
  g.addColorStop(0.55, '#c1270f');
  g.addColorStop(1, '#ff8a1f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, H);
  // 波浪状边缘 + 气泡
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const t = performance.now() / 240;
  for (let y = 0; y <= H; y += 14) {
    const off = Math.sin(y / 60 + t) * 8 * s + Math.sin(y / 23 - t * 1.7) * 4 * s;
    ctx.lineTo(w + off, y);
  }
  ctx.lineTo(0, H);
  ctx.closePath();
  const g2 = ctx.createLinearGradient(w - 60, 0, w + 20, 0);
  g2.addColorStop(0, '#ff7a18');
  g2.addColorStop(1, '#ffd23f');
  ctx.fillStyle = g2;
  ctx.shadowColor = '#ff6a00'; ctx.shadowBlur = 24 * s;
  ctx.fill();
  ctx.restore();
}

function drawRope() {
  const s = App.cam.scale;
  const a = App.pos[0], b = App.pos[1];
  const ax = sx(a.x), ay = sy(a.y - 6);
  const bx = sx(b.x), by = sy(b.y - 6);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 + Math.min(28, Math.hypot(bx - ax, by - ay) * 0.08);
  const rescuing = a.rescuing || b.rescuing;
  ctx.strokeStyle = rescuing ? '#ffd23f' : '#8a5a2b';
  ctx.lineWidth = Math.max(3, (rescuing ? 7 : 5) * s);
  ctx.lineCap = 'round';
  if (rescuing) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 14 * s; }
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(mx, my, bx, by); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rescuing ? '#fff3b0' : '#b5793f';
  ctx.lineWidth = Math.max(1.5, 2.5 * s);
  ctx.stroke();
}

function drawPlayer(i) {
  const p = App.pos[i];
  const s = App.cam.scale;
  const x = sx(p.x), y = sy(p.y);
  const w = App.level.playerW * s, h = App.level.playerH * s;
  const color = i === 0 ? '#ff7a5c' : '#4bb8ff';
  const dark = i === 0 ? '#d9532f' : '#2f8fd6';

  ctx.save();
  ctx.globalAlpha = 0.18; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, sy(p.y + App.level.playerH / 2), w * 0.5, 5 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);
  if (p.dead) { ctx.globalAlpha = 0.6; ctx.rotate(Math.PI / 2); }
  if (p.invuln && !p.dead) {
    ctx.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 70);
  }
  ctx.scale(1, p.sy);

  // 形象：图片贴图按原角色高度等比缩放（底部对齐，大小与原来一致）；未加载完则退回方块小人
  const spr = playerSprites[i];
  if (spr && spr.complete && spr.naturalWidth) {
    const k = Math.min((w * 1.35) / spr.naturalWidth, h / spr.naturalHeight);
    const dw = spr.naturalWidth * k, dh = spr.naturalHeight * k;
    ctx.save();
    ctx.scale(p.facing >= 0 ? 1 : -1, 1);      // 朝向：左右翻转
    ctx.drawImage(spr, -dw / 2, h / 2 - dh, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = color;
    roundRect(-w / 2, -h / 2, w, h, 10 * s); ctx.fill();
    ctx.fillStyle = '#ffffff30';
    roundRect(-w / 2 + 4 * s, -h / 4, w - 8 * s, h / 2.4, 8 * s); ctx.fill();

    ctx.fillStyle = dark;
    const moving = Math.abs(App.net.players[i].vx) > 20;
    const legSwing = App.net.players[i].grounded && moving ? Math.sin(performance.now() / 90) * 4 : (App.net.players[i].grounded ? 0 : 3);
    roundRect(-w / 2 + 3 * s, h / 2 - 2 * s, 9 * s, (7 + legSwing) * s, 3 * s); ctx.fill();
    roundRect(w / 2 - 12 * s, h / 2 - 2 * s, 9 * s, (7 - legSwing) * s, 3 * s); ctx.fill();

    const dir = p.facing >= 0 ? 1 : -1;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-5 * s + dir * 3 * s, -h / 6, 6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(7 * s + dir * 3 * s, -h / 6, 6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#22303f';
    ctx.beginPath(); ctx.arc(-5 * s + dir * 5 * s, -h / 6, 3 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(7 * s + dir * 5 * s, -h / 6, 3 * s, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#ff000022';
    ctx.beginPath(); ctx.arc(-9 * s, 0, 4 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(11 * s, 0, 4 * s, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();

  // 头顶标签：显示玩家昵称
  const me = i === App.mySlot;
  const raw = (App.names && App.names[i]) || (me ? '玩家' : '队友');
  const name = (raw.length > 8 ? raw.slice(0, 7) + '…' : raw) + (me ? '（你）' : '');
  ctx.save();
  ctx.font = `700 ${Math.max(11, 13 * s)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = 'center';
  const tw = ctx.measureText(name).width + 14 * s;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = me ? '#ffd23f' : '#00000099';
  roundRect(x - tw / 2, y - h / 2 - 26 * s, tw, 18 * s, 9 * s); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = me ? '#111' : '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x, y - h / 2 - 17 * s);
  ctx.restore();

  // 被队友用绳子拉起时的进度
  if (p.rescuing) {
    const prog = p.rescue || 0;
    const bw = 48 * s, bh = 6 * s, by = y - h / 2 - 44 * s;
    ctx.save();
    ctx.font = `700 ${Math.max(13, 17 * s)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd23f';
    ctx.fillText('↑', x, by - 14 * s);
    ctx.fillStyle = '#00000066';
    roundRect(x - bw / 2, by, bw, bh, bh / 2); ctx.fill();
    ctx.fillStyle = '#ffd23f';
    roundRect(x - bw / 2, by, bw * prog, bh, bh / 2); ctx.fill();
    ctx.restore();
  }
}

function drawParticles() {
  for (const pt of App.particles) {
    ctx.globalAlpha = Math.max(0, pt.life / pt.max);
    ctx.fillStyle = pt.color;
    const s = pt.size * App.cam.scale;
    ctx.fillRect(sx(pt.x) - s / 2, sy(pt.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ 按钮绑定
function boot() {
  connect();

  const savedName = localStorage.getItem('glh_name');
  if (savedName) $('inputName').value = savedName;
  const savedCode = localStorage.getItem('glh_code');
  if (savedCode) $('inputCode').value = savedCode;

  $('btnCreate').onclick = () => {
    Sound.init();
    App.myName = ($('inputName').value || '玩家1').trim().slice(0, 10);
    localStorage.setItem('glh_name', App.myName);
    send({ t: 'create', name: App.myName });
  };
  $('btnJoin').onclick = () => {
    Sound.init();
    const code = ($('inputCode').value || '').trim();
    if (!/^\d{3,6}$/.test(code)) { toast('请输入正确的房间号'); return; }
    App.myName = ($('inputName').value || '玩家2').trim().slice(0, 10);
    localStorage.setItem('glh_name', App.myName);
    send({ t: 'join', code, name: App.myName });
  };
  $('inputCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  $('btnStart').onclick = () => send({ t: 'start' });
  $('btnLeave').onclick = () => goHome();
  $('btnQuit').onclick = () => goHome();
  $('btnSound').onclick = () => { Sound.on = !Sound.on; $('btnSound').textContent = Sound.on ? '🔊' : '🔇'; };
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(App.roomCode); toast('房间号已复制'); }
    catch (_) { toast('房间号：' + App.roomCode); }
  };

  bindTouch();
  requestAnimationFrame(frame);
}

boot();
