'use strict';

/*
 * 哥俩好 · 无尽模式
 * 服务端：静态文件 + WebSocket 房间 + 权威物理 + 无限关卡生成
 *
 * 玩法：两人被一根绳子绑在一起，背后有一堵岩浆墙不断推进。
 *       不停往右跑，跑得越远分越高，捡金币额外加分；掉坑会被队友用绳子拉上来。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// 模拟参数
// ---------------------------------------------------------------------------
const TICK_HZ = 60;
const DT = 1 / TICK_HZ;
const SEND_EVERY = 2;            // 状态 30Hz
const WORLD_EVERY = 12;          // 关卡几何 5Hz

const GRAVITY = 2400;            // 重力小一点 → 滞空更久、跳得更远
const MOVE_ACCEL = 3800;
const MOVE_MAX = 350;            // 水平最高速（决定跳跃的水平距离）
const GROUND_FRICTION = 0.78;
const AIR_FRICTION = 0.94;
const JUMP_VEL = -900;           // 起跳初速度（越大跳得越高越远）
const JUMP_CUT = 220;            // 松开跳跃键时的上升速度上限（长按跳更高）
const MAX_FALL = 1600;
const COYOTE = 0.10;
const JUMP_BUFFER = 0.12;

const P_W = 32, P_H = 44;
const P_HW = P_W / 2, P_HH = P_H / 2;
const ROPE_LEN = 200;            // 绳子最长长度

// 掉坑救援：一方掉下悬崖，另一方站在实地上就能用绳子把他拉上来
const RESCUE_TIME = 0.7;         // 拉上来所需时间（秒）
const PIT_DEPTH = 8;             // 脚底低于地面多少像素算掉坑

const GROUND_Y = 600;
const DEATH_Y = 1000;            // 掉到这个高度以下算摔死
const SPAWN_X = 200;             // 出生点（也是分数原点基准）
const WALL_START = -600;         // 岩浆墙初始位置
const WALL_BASE_SPEED = 110;
const WALL_MAX_SPEED = 275;      // 低于玩家最高速 320，技术好可以一直跑
const LIVES = 3;
const COIN_SCORE = 10;
const METER_PX = 10;             // 每 10 像素算 1 分

// ---------------------------------------------------------------------------
// 物理
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

function aabb(px, py, s) {
  return (
    px + P_HW > s.x && px - P_HW < s.x + s.w &&
    py + P_HH > s.y && py - P_HH < s.y + s.h
  );
}

function makePlayer(slot) {
  return {
    slot, x: 0, y: 0, vx: 0, vy: 0,
    grounded: false, facing: 1,
    coyote: 0, buf: 0, jumpHeld: false, dead: false,
    rescuing: false, rescue: 0,   // 掉坑后被队友用绳子拉上来的状态
  };
}

// ---------------------------------------------------------------------------
// 无限关卡生成
// ---------------------------------------------------------------------------
function generate(g, targetX) {
  let guard = 0;
  while (g.genX < targetX && guard++ < 500) {
    const d = Math.min(1, Math.max(0, (g.genX - SPAWN_X) / 9000)); // 难度 0..1

    // 一段地面
    const gl = rand(300, 470);
    g.platforms.push({ x: g.genX, y: GROUND_Y, w: gl, h: 900 });

    // 金币（有时在缺口上方摆成弧线，考验跳跃）
    if (Math.random() < 0.55) {
      const n = 3 + Math.floor(Math.random() * 3);
      const cx = g.genX + gl * 0.5;
      for (let i = 0; i < n; i++) {
        g.coins.push({
          x: cx + (i - (n - 1) / 2) * 46,
          y: GROUND_Y - 60 - Math.sin(((i + 0.5) / n) * Math.PI) * 80,
        });
      }
    }

    g.genX += gl;

    // 缺口（宽度随难度增加，但始终小于跳跃射程）
    const gapChance = 0.55 + d * 0.4;
    if (Math.random() < gapChance) {
      const gw = rand(90, 100 + d * 45);
      // 缺口上方偶尔摆金币
      if (Math.random() < 0.5) {
        const cn = 3;
        for (let i = 0; i < cn; i++) {
          g.coins.push({ x: g.genX + (i + 0.5) * (gw / cn), y: GROUND_Y - 90 - Math.sin(((i + 0.5) / cn) * Math.PI) * 40 });
        }
      }
      g.genX += gw;
    }
    g.worldDirty = true;
  }
}

function groundAt(g, x) {
  for (const s of g.platforms) if (x >= s.x && x <= s.x + s.w) return s;
  return null;
}

function snapToGround(g, x) {
  generate(g, x + 2200);
  const s = groundAt(g, x);
  if (s && x <= s.x + s.w - 70) return x;
  let best = null;
  for (const p of g.platforms) {
    if (p.x + p.w > x - 300 && (!best || p.x < best.x)) best = p;
  }
  return best ? Math.max(best.x + 80, x - 60) : x;
}

function prune(g) {
  const cut = g.wallX - 500;
  if (g.pruneAt && cut - g.pruneAt < 300) return;
  g.pruneAt = cut;
  const before = g.platforms.length + g.hazards.length + g.coins.length;
  g.platforms = g.platforms.filter((s) => s.x + s.w > cut);
  g.hazards = g.hazards.filter((s) => s.x + s.w > cut);
  g.coins = g.coins.filter((c) => c.x > cut);
  if (g.platforms.length + g.hazards.length + g.coins.length !== before) g.worldDirty = true;
}

function newGame() {
  const g = {
    platforms: [{ x: -500, y: GROUND_Y, w: 1500, h: 900 }],
    hazards: [],
    coins: [],
    genX: 1000,
    wallX: WALL_START,
    wallSpeed: WALL_BASE_SPEED,
    pruneAt: 0,
    worldDirty: true,
    p: [makePlayer(0), makePlayer(1)],
    inputs: [{}, {}],
    lives: LIVES,
    time: 0,
    phase: 'countdown',
    phaseTimer: 3,
    invuln: 0,
    maxX: SPAWN_X,
    coinsGot: 0,
    score: 0,
    lastDeath: null,
  };
  g.p[0].x = SPAWN_X - 30; g.p[0].y = GROUND_Y - P_HH; g.p[0].grounded = true;
  g.p[1].x = SPAWN_X + 30; g.p[1].y = GROUND_Y - P_HH; g.p[1].grounded = true;
  generate(g, SPAWN_X + 2600);
  return g;
}

// ---------------------------------------------------------------------------
// 物理步进
// ---------------------------------------------------------------------------
function applyInput(g, i, active) {
  const p = g.p[i];
  const inp = active ? (g.inputs[i] || {}) : {};
  const left = !!inp.left, right = !!inp.right, jump = !!inp.jump;

  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (dir !== 0) {
    p.vx += dir * MOVE_ACCEL * DT;
    p.facing = dir;
  } else {
    p.vx *= p.grounded ? GROUND_FRICTION : AIR_FRICTION;
    if (Math.abs(p.vx) < 1) p.vx = 0;
  }
  p.vx = clamp(p.vx, -MOVE_MAX, MOVE_MAX);

  p.vy += GRAVITY * DT;
  if (p.vy > MAX_FALL) p.vy = MAX_FALL;

  if (p.grounded) p.coyote = COYOTE; else p.coyote -= DT;
  if (jump) {
    if (!p.jumpHeld) p.buf = JUMP_BUFFER;
    p.jumpHeld = true;
  } else {
    p.jumpHeld = false;
  }
  p.buf -= DT;
  if (p.buf > 0 && p.coyote > 0) {
    p.vy = JUMP_VEL; p.buf = 0; p.coyote = 0; p.grounded = false;
  }
  if (!jump && p.vy < -JUMP_CUT) p.vy = -JUMP_CUT;
}

function integrate(g, p) {
  p.x += p.vx * DT;
  for (const s of g.platforms) {
    if (!aabb(p.x, p.y, s)) continue;
    if (p.vx > 0) p.x = s.x - P_HW;
    else if (p.vx < 0) p.x = s.x + s.w + P_HW;
    p.vx = 0;
  }
  p.y += p.vy * DT;
  p.grounded = false;
  for (const s of g.platforms) {
    if (!aabb(p.x, p.y, s)) continue;
    if (p.vy > 0) { p.y = s.y - P_HH; p.vy = 0; p.grounded = true; }
    else if (p.vy < 0) { p.y = s.y + s.h + P_HH; p.vy = 0; }
  }
}

function ropeConstraint(g) {
  const a = g.p[0], b = g.p[1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-4 || d <= ROPE_LEN) return;
  const nx = dx / d, ny = dy / d;
  const diff = d - ROPE_LEN;
  a.x += nx * diff * 0.5; a.y += ny * diff * 0.5;
  b.x -= nx * diff * 0.5; b.y -= ny * diff * 0.5;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel > 0) {
    const j = rel * 0.5;
    a.vx += nx * j; a.vy += ny * j;
    b.vx -= nx * j; b.vy -= ny * j;
  }
}

function depenetrate(g, p) {
  for (const s of g.platforms) {
    if (!aabb(p.x, p.y, s)) continue;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const ox = P_HW + s.w / 2 - Math.abs(p.x - cx);
    const oy = P_HH + s.h / 2 - Math.abs(p.y - cy);
    if (ox < oy) p.x += p.x < cx ? -ox : ox;
    else {
      if (p.y < cy) { p.y -= oy; p.grounded = true; if (p.vy > 0) p.vy = 0; }
      else { p.y += oy; if (p.vy < 0) p.vy = 0; }
    }
  }
}

function checkHazards(g) {
  for (const p of g.p) {
    if (p.y - P_HH > DEATH_Y) { p.dead = true; return 'fall'; }
    if (p.x + P_HW < g.wallX) { p.dead = true; return 'wall'; }
    for (const h of g.hazards) {
      if (aabb(p.x, p.y, h)) { p.dead = true; return 'spike'; }
    }
  }
  return null;
}

function collectCoins(g) {
  for (let i = g.coins.length - 1; i >= 0; i--) {
    const c = g.coins[i];
    for (const p of g.p) {
      if (Math.abs(p.x - c.x) < P_HW + 12 && Math.abs(p.y - c.y) < P_HH + 14) {
        g.coins.splice(i, 1);
        g.coinsGot++;
        g.worldDirty = true;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------
const rooms = new Map();

function newCode() {
  for (let i = 0; i < 400; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-6);
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [null, null];
    this.host = 0;
    this.phase = 'lobby';         // lobby | playing
    this.step = 0;
    this.lastActive = Date.now();
    this.emptySince = null;
    this.best = null;             // 本房间最好成绩
    this.game = null;
  }

  get size() { return this.players.filter(Boolean).length; }

  // ---- 网络 ----
  sendTo(ws, obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
  }
  broadcast(obj) { for (const p of this.players) if (p) this.sendTo(p.ws, obj); }

  playerList() {
    return this.players.map((p, i) => p ? { slot: i, name: p.name, connected: true } : { slot: i, name: null, connected: false });
  }
  roomInfo() {
    return { t: 'room', code: this.code, host: this.host, phase: this.phase, best: this.best, players: this.playerList() };
  }

  levelMeta() {
    return {
      playerW: P_W, playerH: P_H, groundY: GROUND_Y, deathY: DEATH_Y, ropeLen: ROPE_LEN,
      names: this.players.map((p) => (p ? p.name : '')),
    };
  }

  worldPayload() {
    const g = this.game;
    const cut = g.wallX - 500;
    return {
      t: 'world',
      platforms: g.platforms.filter((s) => s.x + s.w > cut),
      hazards: g.hazards.filter((s) => s.x + s.w > cut),
      coins: g.coins.filter((c) => c.x > cut),
    };
  }

  broadcastWorld() {
    if (!this.game) return;
    this.broadcast(this.worldPayload());
  }

  broadcastState() {
    const g = this.game;
    if (!g) return;
    this.broadcast({
      t: 'state',
      time: g.time,
      lives: g.lives,
      phase: g.phase,
      timer: g.phaseTimer,
      score: g.score,
      coins: g.coinsGot,
      wallX: +g.wallX.toFixed(1),
      lastDeath: g.lastDeath,
      players: g.p.map((p) => ({
        x: +p.x.toFixed(2), y: +p.y.toFixed(2),
        vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1),
        grounded: p.grounded, facing: p.facing, dead: p.dead, invuln: g.invuln > 0,
        rescuing: p.rescuing, rescue: +p.rescue.toFixed(2),
      })),
    });
  }

  start() {
    this.game = newGame();
    this.phase = 'playing';
    this.step = 0;
    this.lastActive = Date.now();
    this.broadcast({ t: 'level', level: this.levelMeta() });
    this.broadcastWorld();
    this.broadcast({ t: 'started' });
    this.broadcastState();
  }

  // ---- 逻辑 ----
  tick() {
    const g = this.game;
    if (!g) return;
    this.lastActive = Date.now();

    if (g.phase === 'countdown') {
      g.phaseTimer -= DT;
      stepPhysics(this, false);
      if (g.phaseTimer <= 0) { g.phase = 'play'; g.phaseTimer = 0; this.broadcast({ t: 'go' }); }
      return;
    }
    if (g.phase === 'play') {
      g.time += DT;
      if (g.invuln > 0) g.invuln -= DT;

      // 岩浆墙推进
      g.wallSpeed = Math.min(WALL_MAX_SPEED, WALL_BASE_SPEED + g.maxX * 0.02);
      g.wallX += g.wallSpeed * DT;

      stepPhysics(this, true);

      if (g.phase === 'play') {
        g.maxX = Math.max(g.maxX, g.p[0].x, g.p[1].x);
        collectCoins(g);
        g.score = Math.floor(Math.max(0, g.maxX - SPAWN_X) / METER_PX) + g.coinsGot * COIN_SCORE;
        generate(g, g.maxX + 2400);
        prune(g);
      }
      return;
    }
    if (g.phase === 'dead') {
      g.phaseTimer -= DT;
      if (g.phaseTimer <= 0) this.afterDeath();
    }
  }

  afterDeath() {
    const g = this.game;
    g.lives -= 1;
    g.lastDeath = null;
    if (g.lives <= 0) {
      g.phase = 'gameover';
      if (this.best === null || g.score > this.best) this.best = g.score;
      this.broadcast({ t: 'gameover', score: g.score, coins: g.coinsGot, best: this.best });
      return;
    }
    // 复活：两人落到前方地面，并把岩浆墙往回推一段，给点喘息时间
    const front = Math.max(g.p[0].x, g.p[1].x, SPAWN_X);
    const rx = snapToGround(g, front + 280);
    g.p[0].x = rx - 28; g.p[1].x = rx + 28;
    for (const p of g.p) { p.y = GROUND_Y - P_HH; p.vx = 0; p.vy = 0; p.grounded = true; p.dead = false; p.coyote = COYOTE; p.buf = 0; p.jumpHeld = false; p.rescuing = false; p.rescue = 0; }
    g.wallX = Math.min(g.wallX, rx - 720);
    g.wallSpeed = WALL_BASE_SPEED;
    g.maxX = Math.max(g.maxX, rx);
    g.invuln = 1.6;
    g.phase = 'play';
    prune(g);
    this.broadcastWorld();
    this.broadcast({ t: 'respawn' });
  }

  triggerDeath(reason) {
    const g = this.game;
    if (g.phase !== 'play') return;
    g.phase = 'dead';
    g.phaseTimer = 1.0;
    g.lastDeath = reason;
    this.broadcast({ t: 'death', reason });
  }
}

// 掉坑救援：一方掉下悬崖时，另一方站在实地上就能用绳子把他拉上来
function updateRescue(g) {
  // 1) 正在被拉的：锚点必须还站在地上，然后把他拽到锚点身边的平台地面上
  for (let i = 0; i < 2; i++) {
    const p = g.p[i], anchor = g.p[1 - i];
    if (!p.rescuing) continue;
    if (!anchor.grounded) { p.rescuing = false; p.rescue = 0; continue; }
    p.rescue = Math.min(1, p.rescue + DT / RESCUE_TIME);
    const plat = groundAt(g, anchor.x);
    const baseY = (plat ? plat.y : GROUND_Y) - P_HH;
    const cx = plat ? plat.x + plat.w / 2 : anchor.x;
    const tx = plat ? clamp(anchor.x + (anchor.x < cx ? 30 : -30), plat.x + 24, plat.x + plat.w - 24) : anchor.x;
    const k = Math.min(1, DT * 7);
    p.x += (tx - p.x) * k;
    p.y += (baseY - p.y) * k;
    p.vx = 0; p.vy = 0;
    if (p.rescue >= 1) {
      p.x = tx; p.y = baseY; p.vx = 0; p.vy = 0;
      p.grounded = true; p.rescuing = false; p.rescue = 0; p.coyote = COYOTE;
    }
  }

  // 2) 检测新的掉坑者：脚底低于地面、脚下没有平台、且不是正在被拉
  const inPit = (p) => (
    !p.grounded && !p.rescuing &&
    p.y + P_HH > GROUND_Y + PIT_DEPTH && p.y < DEATH_Y &&
    !groundAt(g, p.x)
  );
  const d0 = inPit(g.p[0]), d1 = inPit(g.p[1]);
  if (d0 && d1) return;            // 两人都掉下去了，谁也拉不动谁
  if (d0 || d1) {
    const hang = d0 ? g.p[0] : g.p[1];
    const anchor = d0 ? g.p[1] : g.p[0];
    // 锚点必须稳稳站在地面上才能发力
    if (anchor.grounded && anchor.y + P_HH <= GROUND_Y + 4 && !anchor.rescuing) {
      hang.rescuing = true; hang.rescue = 0;
    }
  }
}

function stepPhysics(room, active) {
  const g = room.game;
  if (active) updateRescue(g);
  for (let i = 0; i < 2; i++) if (!g.p[i].rescuing) applyInput(g, i, active);
  for (let i = 0; i < 2; i++) if (!g.p[i].rescuing) integrate(g, g.p[i]);
  if (!g.p[0].rescuing && !g.p[1].rescuing) ropeConstraint(g);
  for (let i = 0; i < 2; i++) if (!g.p[i].rescuing) depenetrate(g, g.p[i]);
  if (active && room.game.invuln <= 0) {
    const reason = checkHazards(g);
    if (reason) room.triggerDeath(reason);
  } else if (active) {
    // 无敌时间内只检查摔落
    for (const p of g.p) if (p.y - P_HH > DEATH_Y) { room.triggerDeath('fall'); break; }
  }
}

// ---------------------------------------------------------------------------
// 连接处理
// ---------------------------------------------------------------------------
let uid = 0;
const wss = new WebSocketServer({ noServer: true });

function attach(ws) {
  ws.id = ++uid;
  ws.room = null;
  ws.slot = -1;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    handle(ws, m);
  });
  ws.on('close', () => leaveRoom(ws, true));
  ws.on('error', () => {});
}

function handle(ws, m) {
  switch (m.t) {
    case 'create': return onCreate(ws, m);
    case 'join': return onJoin(ws, m);
    case 'start': return onStart(ws);
    case 'rematch': return onRematch(ws);
    case 'input': return onInput(ws, m);
    case 'leave': return leaveRoom(ws, false);
  }
}

function onCreate(ws, m) {
  leaveRoom(ws, false);
  const code = newCode();
  const room = new Room(code);
  room.emptySince = null;
  rooms.set(code, room);

  const name = String(m.name || '玩家1').slice(0, 10);
  room.players[0] = { id: ws.id, ws, name, input: {} };
  room.host = 0;
  ws.room = room;
  ws.slot = 0;

  room.sendTo(ws, { t: 'created', code, slot: 0 });
  room.broadcast(room.roomInfo());
}

function onJoin(ws, m) {
  const code = String(m.code || '').trim();
  const room = rooms.get(code);
  if (!room) return ws.send(JSON.stringify({ t: 'error', msg: '房间不存在，请检查房间号' }));

  // 清理已失效的连接（刷新页面重进时常见）
  let changed = false;
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && (!p.ws || p.ws.readyState !== 1)) {
      if (p.ws) { p.ws.room = null; p.ws.slot = -1; }
      room.players[i] = null;
      changed = true;
    }
  }
  if (changed) {
    const left = room.players.findIndex(Boolean);
    if (left >= 0) room.host = left;
    room.game = null;
    room.phase = 'lobby';
  }

  const free = room.players[0] ? (room.players[1] ? -1 : 1) : 0;
  if (free === -1) return ws.send(JSON.stringify({ t: 'error', msg: '房间已满' }));

  leaveRoom(ws, false);
  const other = 1 - free;
  if (!room.players[other]) room.host = free;
  const name = String(m.name || (free === 0 ? '玩家1' : '玩家2')).slice(0, 10);
  room.players[free] = { id: ws.id, ws, name, input: {} };
  room.emptySince = null;
  ws.room = room;
  ws.slot = free;
  room.lastActive = Date.now();

  room.sendTo(ws, { t: 'joined', code, slot: free });
  room.broadcast(room.roomInfo());
}

function onStart(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.slot !== room.host) return ws.send(JSON.stringify({ t: 'error', msg: '只有房主可以开始' }));
  if (room.size < 2) return ws.send(JSON.stringify({ t: 'error', msg: '需要两名玩家才能开始' }));
  room.start();
}

function onRematch(ws) {
  const room = ws.room;
  if (!room) return;
  if (room.size < 2) return ws.send(JSON.stringify({ t: 'error', msg: '需要两名玩家才能开始' }));
  const g = room.game;
  if (!g || g.phase === 'gameover') room.start();
}

function onInput(ws, m) {
  const room = ws.room;
  if (!room || ws.slot < 0 || !room.game) return;
  room.game.inputs[ws.slot] = { left: !!m.left, right: !!m.right, jump: !!m.jump };
}

function leaveRoom(ws, notify) {
  const room = ws.room;
  if (!room) return;
  const slot = ws.slot;
  if (slot >= 0) room.players[slot] = null;

  const leftSlot = room.players.findIndex(Boolean);
  if (leftSlot >= 0) {
    room.host = leftSlot;
    room.phase = 'lobby';
    room.game = null;
    room.players[leftSlot].input = {};
    if (notify) {
      room.broadcast({ t: 'peerLeft', left: slot });
      room.broadcast(room.roomInfo());
    }
  } else {
    room.emptySince = Date.now();
    room.phase = 'lobby';
    room.game = null;
  }
  ws.room = null;
  ws.slot = -1;
}

// ---------------------------------------------------------------------------
// HTTP 静态服务
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 健康检查（云平台用）
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, up: Math.round(process.uptime()) }));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => { attach(ws); wss.emit('connection', ws, req); });
});

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== 'playing' || !room.game) continue;
    try {
      room.tick();
      room.step++;
      if (room.step % SEND_EVERY === 0) {
        room.broadcastState();
        if (room.game && (room.step % WORLD_EVERY === 0 || room.game.worldDirty)) {
          room.game.worldDirty = false;
          room.broadcastWorld();
        }
      }
    } catch (e) {
      console.error('[room ' + room.code + '] tick error:', e);
    }
  }
}, 1000 / TICK_HZ);

// 清理房间：空房间保留 2 分钟（宽限刷新重进），长时间无人的直接回收
const EMPTY_GRACE = 2 * 60 * 1000;
const IDLE_TIMEOUT = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.size === 0) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > EMPTY_GRACE) rooms.delete(code);
    } else if (now - room.lastActive > IDLE_TIMEOUT) {
      rooms.delete(code);
    }
  }
}, 30 * 1000);

function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function banner(port) {
  console.log('');
  console.log('  🎮  哥俩好 · 无尽模式 —— 双人联机');
  console.log('  ──────────────────────────────────────────');
  console.log('  本机打开:      http://localhost:' + port);
  for (const ip of localIPs()) console.log('  同一局域网:    http://' + ip + ':' + port);
  console.log('  ──────────────────────────────────────────');
  console.log('  玩法：一人创建房间，另一人输入房间号加入；房主开始。');
  console.log('  目标：被绳子绑在一起，躲开岩浆墙和障碍，跑得越远分越高。');
  console.log('  操作：A/← 左移  D/→ 右移  W/↑/空格 跳跃（手机用屏幕按钮）');
  console.log('');
}

function startListening(port, tries) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      console.log('  端口 ' + port + ' 已被占用，尝试 ' + (port + 1) + ' …');
      startListening(port + 1, tries - 1);
    } else {
      console.error('服务器启动失败：' + e.message);
      process.exit(1);
    }
  });
  server.listen(port, () => banner(port));
}

startListening(PORT, 20);
