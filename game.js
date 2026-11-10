'use strict';
/* ==========================================================================
   ASIFINTE MOTTA PIDETHAM — plain canvas + vanilla JS
   Logical resolution is fixed (W x H); the canvas is scaled to fit the window.
   ========================================================================== */

/* ---------------------------- TUNABLE CONSTANTS --------------------------- */
const CONFIG = {
  W: 800, H: 600,               // logical game size; switched at runtime (see LAYOUTS)
  GROUND_H: 40,                 // height of the green ground strip

  LIVES: 3,                     // starting lives
  POINTS_PER_LEVEL: 10,         // score needed per difficulty step
  MAX_LEVEL: 12,                // difficulty cap (keeps game playable)

  // Hen
  HEN_Y: 70,                    // hen's flight height
  HEN_SPEED_BASE: 110,          // px/s at level 0
  HEN_SPEED_PER_LEVEL: 14,      // extra px/s per level
  HEN_SPEED_JITTER: 0.5,        // random speed factor range: 1 +/- this
  HEN_CHANGE_MIN: 1.0,          // seconds between random speed/direction changes
  HEN_CHANGE_MAX: 3.0,
  HEN_REVERSE_CHANCE: 0.35,     // chance a change flips direction

  // Egg dropping (seconds between drops, random in [min, max])
  DROP_MIN_BASE: 0.8,
  DROP_MAX_BASE: 2.0,
  DROP_MIN_PER_LEVEL: 0.04,     // interval shrinks by this per level
  DROP_MAX_PER_LEVEL: 0.11,
  DROP_MIN_FLOOR: 0.45,         // never faster than this
  DROP_MAX_FLOOR: 0.9,

  // Eggs
  GRAVITY_BASE: 380,            // px/s^2 at level 0
  GRAVITY_PER_LEVEL: 40,        // extra px/s^2 per level
  EGG_RX: 11, EGG_RY: 15,       // egg radii
  GOLDEN_CHANCE: 0.05,          // probability an egg is golden (+5)
  ROTTEN_CHANCE: 0.15,          // probability an egg is rotten (-1 life)
  GOLDEN_POINTS: 5,
  RAINBOW_INTERVAL: 60,         // seconds of play between rainbow eggs (one per minute)
  RAINBOW_POINTS: 10,           // points for catching a rainbow egg

  // Nest
  NEST_W: 110,                  // width of the nest opening
  NEST_SPEED: 650,              // keyboard speed px/s
  NEST_FOLLOW: 22,              // pointer smoothing (higher = snappier)
  NEST_Y_OFFSET: 80,            // rim distance above the bottom of the canvas
};

// Two logical sizes: landscape for desktops/rotated phones, portrait for phones held upright.
const LAYOUTS = { landscape: { W: 800, H: 600 }, portrait: { W: 480, H: 720 } };
const IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

/* -------------------------------- HELPERS --------------------------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------------------------- AUDIO --------------------------------- */
// All sounds are synthesised with the Web Audio API; no audio files.
class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('eggCatcherMuted') === '1'; } catch (e) {}
  }
  // Browsers require a user gesture before audio can start.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('eggCatcherMuted', this.muted ? '1' : '0'); } catch (e) {}
  }
  // One enveloped oscillator note, optionally sweeping from f0 to f1.
  tone(f0, f1, dur, type = 'sine', vol = 0.2, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  catch()  { this.tone(520, 900, 0.12, 'triangle', 0.25); this.tone(900, 1300, 0.1, 'triangle', 0.2, 0.07); }
  golden() { [660, 880, 1100, 1320].forEach((f, i) => this.tone(f, f, 0.14, 'triangle', 0.22, i * 0.07)); }
  rotten() { this.tone(180, 70, 0.3, 'sawtooth', 0.22); }
  miss()   { this.tone(300, 80, 0.25, 'square', 0.15); }
  over()   { [392, 330, 262, 196].forEach((f, i) => this.tone(f, f * 0.96, 0.3, 'triangle', 0.25, i * 0.22)); }
  rainbow() { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, f, 0.16, 'triangle', 0.22, i * 0.06)); }
  start()  { this.tone(440, 880, 0.15, 'triangle', 0.2); }
}

/* -------------------------------- PARTICLES ------------------------------- */
// Handles short-lived effects: burst particles, ground splats, floating text.
class Particles {
  constructor() { this.dots = []; this.splats = []; this.texts = []; }
  reset() { this.dots.length = 0; this.splats.length = 0; this.texts.length = 0; }

  burst(x, y, color, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI, 0), s = rand(60, 220);   // fan upward
      this.dots.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
                       life: 0, max: rand(0.35, 0.7), r: rand(2, 4.5), color });
    }
  }
  splat(x, y, color = '#ffd84a') {
    this.splats.push({ x, y, life: 0, max: 4, color,
      drops: Array.from({ length: 5 }, () => ({ dx: rand(-22, 22), r: rand(2, 4) })) });
  }
  text(x, y, str, color) { this.texts.push({ x, y, str, color, life: 0, max: 0.9 }); }

  update(dt) {
    for (const p of this.dots) { p.life += dt; p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    for (const s of this.splats) s.life += dt;
    for (const t of this.texts) { t.life += dt; t.y -= 40 * dt; }
    this.dots = this.dots.filter(p => p.life < p.max);
    this.splats = this.splats.filter(s => s.life < s.max);
    this.texts = this.texts.filter(t => t.life < t.max);
  }
  draw(ctx) {
    for (const s of this.splats) {                      // splat fades during last second
      ctx.globalAlpha = clamp(s.max - s.life, 0, 1);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 24, 5, 0, 0, Math.PI * 2); ctx.fill();
      for (const d of s.drops) { ctx.beginPath(); ctx.arc(s.x + d.dx, s.y - 3, d.r, 0, Math.PI * 2); ctx.fill(); }
    }
    for (const p of this.dots) {
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.textAlign = 'center'; ctx.font = 'bold 22px sans-serif';
    for (const t of this.texts) {
      ctx.globalAlpha = 1 - t.life / t.max;
      ctx.fillStyle = t.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
      ctx.strokeText(t.str, t.x, t.y); ctx.fillText(t.str, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}

/* ----------------------------------- EGG ---------------------------------- */
const EGG_TYPES = {
  normal: { fill: '#fffaf0', stroke: '#d8c9a8' },
  golden: { fill: '#ffd700', stroke: '#b8860b' },
  rotten: { fill: '#3d5a2a', stroke: '#1e3012' },
  rainbow: { fill: '#ffffff', stroke: '#ffffff' },        // fill replaced by a rainbow gradient
};

class Egg {
  constructor(x, y, type) {
    this.x = x; this.y = y; this.type = type;
    this.vy = 40;                                     // small initial downward speed
    this.rot = rand(-0.3, 0.3);
    this.rotSpeed = rand(-2, 2);                      // slight wobble while falling
    this.rx = CONFIG.EGG_RX; this.ry = CONFIG.EGG_RY;
    this.dead = false;
    this.passedRim = false;                           // already crossed nest rim line (missed the opening)
  }
  get bottom() { return this.y + this.ry; }
  update(dt, gravity) {
    this.vy += gravity * dt;
    this.y += this.vy * dt;
    this.rot += this.rotSpeed * dt;
    this.rot = clamp(this.rot, -0.6, 0.6);
    if (Math.abs(this.rot) >= 0.6) this.rotSpeed = -this.rotSpeed;
  }
  draw(ctx) {
    const c = EGG_TYPES[this.type];
    ctx.save();
    ctx.translate(this.x, this.y); ctx.rotate(this.rot);
    ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
    if (this.type === 'rainbow') {                                 // colour bands that shimmer as it falls
      const g = ctx.createLinearGradient(0, -this.ry, 0, this.ry);
      const cols = ['#ff3b3b', '#ff9a1f', '#ffe135', '#3ddc5a', '#3aa0ff', '#8a4dff'];
      cols.forEach((col, i) => g.addColorStop(i / (cols.length - 1), col));
      ctx.fillStyle = g; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
      ctx.shadowColor = '#fff'; ctx.shadowBlur = 10;
    }
    ctx.beginPath(); ctx.ellipse(0, 0, this.rx, this.ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';                       // shine
    ctx.beginPath(); ctx.ellipse(-4, -6, 3, 5, 0.4, 0, Math.PI * 2); ctx.fill();
    if (this.type === 'rotten') {                                  // dark spots
      ctx.fillStyle = '#1e3012';
      ctx.beginPath(); ctx.arc(4, 3, 3, 0, Math.PI * 2); ctx.arc(-3, 8, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

/* ----------------------------------- HEN ---------------------------------- */
class Hen {
  constructor() { this.reset(); }
  reset() {
    this.x = CONFIG.W / 2; this.y = CONFIG.HEN_Y;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.speedFactor = 1;
    this.changeTimer = rand(CONFIG.HEN_CHANGE_MIN, CONFIG.HEN_CHANGE_MAX);
    this.dropTimer = rand(CONFIG.DROP_MIN_BASE, CONFIG.DROP_MAX_BASE);
    this.flap = 0;
  }
  // Returns true when it is time to drop an egg.
  update(dt, level) {
    const speed = (CONFIG.HEN_SPEED_BASE + CONFIG.HEN_SPEED_PER_LEVEL * level) * this.speedFactor;
    this.x += this.dir * speed * dt;
    // Bounce at the screen edges
    const m = 50;
    if (this.x < m) { this.x = m; this.dir = 1; }
    if (this.x > CONFIG.W - m) { this.x = CONFIG.W - m; this.dir = -1; }
    // Randomly change speed / direction now and then
    this.changeTimer -= dt;
    if (this.changeTimer <= 0) {
      this.changeTimer = rand(CONFIG.HEN_CHANGE_MIN, CONFIG.HEN_CHANGE_MAX);
      this.speedFactor = rand(1 - CONFIG.HEN_SPEED_JITTER, 1 + CONFIG.HEN_SPEED_JITTER);
      if (Math.random() < CONFIG.HEN_REVERSE_CHANCE) this.dir = -this.dir;
    }
    this.flap += dt * 14;
    this.y = CONFIG.HEN_Y + Math.sin(this.flap * 0.5) * 4;       // gentle bobbing
    // Drop timer: interval shrinks with level (to a floor)
    this.dropTimer -= dt;
    if (this.dropTimer <= 0) {
      const mn = Math.max(CONFIG.DROP_MIN_FLOOR, CONFIG.DROP_MIN_BASE - CONFIG.DROP_MIN_PER_LEVEL * level);
      const mx = Math.max(CONFIG.DROP_MAX_FLOOR, CONFIG.DROP_MAX_BASE - CONFIG.DROP_MAX_PER_LEVEL * level);
      this.dropTimer = rand(mn, Math.max(mn, mx));
      return true;
    }
    return false;
  }
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.dir, 1);                                       // face travel direction
    // tail feathers
    ctx.fillStyle = '#b5651d';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath(); ctx.ellipse(-32, -6 + i * 8, 14, 6, i * 0.5 - 0.3, 0, Math.PI * 2); ctx.fill();
    }
    // body
    ctx.fillStyle = '#f5f0e6'; ctx.strokeStyle = '#c9bda3'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 32, 24, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // head
    ctx.beginPath(); ctx.arc(28, -16, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // comb
    ctx.fillStyle = '#d62828';
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(24 + i * 5, -31 + (i === 1 ? -2 : 0), 5, 0, Math.PI * 2); ctx.fill(); }
    // wattle
    ctx.beginPath(); ctx.ellipse(40, -4, 4, 6, 0, 0, Math.PI * 2); ctx.fill();
    // beak
    ctx.fillStyle = '#f4a300';
    ctx.beginPath(); ctx.moveTo(40, -20); ctx.lineTo(54, -15); ctx.lineTo(40, -11); ctx.closePath(); ctx.fill();
    // eye
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(32, -20, 2.5, 0, Math.PI * 2); ctx.fill();
    // wing, flapping around the shoulder
    ctx.save();
    ctx.translate(-4, -8);
    ctx.rotate(-0.2 + Math.sin(this.flap) * 0.9);
    ctx.fillStyle = '#e4d8bd'; ctx.strokeStyle = '#b9a981';
    ctx.beginPath(); ctx.ellipse(-4, -14, 12, 26, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    // tucked feet
    ctx.strokeStyle = '#f4a300'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-4, 23); ctx.lineTo(-8, 32); ctx.moveTo(6, 23); ctx.lineTo(10, 32); ctx.stroke();
    ctx.restore();
  }
}

/* ---------------------------------- NEST ---------------------------------- */
class Nest {
  constructor() { this.reset(); }
  reset() {
    this.x = CONFIG.W / 2; this.targetX = this.x;
    this.w = CONFIG.NEST_W;
    this.rimY = CONFIG.H - CONFIG.NEST_Y_OFFSET;
    this.squash = 0;                                              // "pop" animation timer
  }
  pop() { this.squash = 0.2; }
  update(dt, keys) {
    // Keyboard moves the target; pointer sets the target directly.
    const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    this.targetX += dir * CONFIG.NEST_SPEED * dt;
    this.targetX = clamp(this.targetX, this.w / 2, CONFIG.W - this.w / 2);
    // Frame-rate independent smoothing
    this.x += (this.targetX - this.x) * (1 - Math.exp(-CONFIG.NEST_FOLLOW * dt));
    this.squash = Math.max(0, this.squash - dt);
  }
  // Is x inside the opening? (slightly forgiving: egg centre must be within the rim)
  contains(x) { return Math.abs(x - this.x) <= this.w / 2 - 4; }
  draw(ctx) {
    const s = 1 + Math.sin((this.squash / 0.2) * Math.PI) * 0.12;   // pop pulse
    ctx.save();
    ctx.translate(this.x, this.rimY); ctx.scale(s, 1 / s);
    const hw = this.w / 2;
    // back rim
    ctx.fillStyle = '#6b4423';
    ctx.beginPath(); ctx.ellipse(0, 0, hw, 9, 0, 0, Math.PI * 2); ctx.fill();
    // bowl
    ctx.fillStyle = '#a0692d'; ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.bezierCurveTo(-hw, 40, -hw * 0.5, 48, 0, 48);
    ctx.bezierCurveTo(hw * 0.5, 48, hw, 40, hw, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // woven pattern: clip to bowl, draw criss-cross strands
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(60,35,10,0.6)'; ctx.lineWidth = 2;
    for (let x = -hw - 40; x < hw + 40; x += 14) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 40, 50); ctx.moveTo(x + 40, 0); ctx.lineTo(x, 50); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(210,160,90,0.7)';
    for (let y = 10; y < 50; y += 12) { ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(hw, y); ctx.stroke(); }
    ctx.restore();
    // front rim
    ctx.strokeStyle = '#7a4e24'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(0, 0, hw, 9, 0, 0, Math.PI); ctx.stroke();
    ctx.restore();
  }
}

/* ----------------------------------- GAME --------------------------------- */
const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover' };

class Game {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.layout = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
    Object.assign(CONFIG, LAYOUTS[this.layout]);
    this.sound = new Sound();
    this.hen = new Hen(); this.nest = new Nest(); this.particles = new Particles();
    this.keys = { left: false, right: false };
    this.clouds = Array.from({ length: 5 }, () => ({
      x: rand(0, CONFIG.W), y: rand(40, 220), s: rand(0.7, 1.4), v: rand(8, 22) }));
    this.highScore = 0;
    try { this.highScore = parseInt(localStorage.getItem('eggCatcherHigh'), 10) || 0; } catch (e) {}
    this.state = STATE.MENU;
    this.stateTime = 0;
    this.newHigh = false;
    this.resetRound();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 150));
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
  }

  // Reset EVERYTHING that belongs to one round (called on every start/restart).
  resetRound() {
    this.score = 0; this.lives = CONFIG.LIVES; this.eggs = [];
    this.newHigh = false;
    this.rainbowTimer = CONFIG.RAINBOW_INTERVAL;                  // countdown to next rainbow egg
    this.hen.reset(); this.nest.reset(); this.particles.reset();
  }
  get level() { return Math.min(CONFIG.MAX_LEVEL, Math.floor(this.score / CONFIG.POINTS_PER_LEVEL)); }
  get gravity() { return CONFIG.GRAVITY_BASE + CONFIG.GRAVITY_PER_LEVEL * this.level; }

  setState(s) { this.state = s; this.stateTime = 0; }
  start() {
    this.sound.unlock(); this.sound.start();
    this.resetRound(); this.setState(STATE.PLAYING);
  }
  togglePause() {
    if (this.state === STATE.PLAYING) this.setState(STATE.PAUSED);
    else if (this.state === STATE.PAUSED) this.setState(STATE.PLAYING);
  }

  /* ------------------------------- input -------------------------------- */
  bindInput() {
    const c = this.canvas;
    // Convert a client x to logical game x (accounts for CSS scaling).
    const toGame = e => { const r = c.getBoundingClientRect(); return (e.clientX - r.left) * CONFIG.W / r.width; };
    const toGameY = e => { const r = c.getBoundingClientRect(); return (e.clientY - r.top) * CONFIG.H / r.height; };

    c.addEventListener('contextmenu', e => e.preventDefault());   // no long-press menu on phones
    c.addEventListener('pointermove', e => { this.nest.targetX = clamp(toGame(e), this.nest.w / 2, CONFIG.W - this.nest.w / 2); });
    c.addEventListener('pointerdown', e => {
      this.sound.unlock();
      const x = toGame(e), y = toGameY(e);
      this.nest.targetX = clamp(x, this.nest.w / 2, CONFIG.W - this.nest.w / 2);
      if (this.state === STATE.PLAYING && this.hitPause(x, y)) { this.togglePause(); return; }
      if (this.state !== STATE.MENU && this.hitMute(x, y)) { this.sound.toggleMute(); return; }
      if (this.state === STATE.MENU) this.start();
      else if (this.state === STATE.PAUSED) this.togglePause();
      else if (this.state === STATE.GAMEOVER && this.stateTime > 0.6 && this.inButton(x, y)) this.start();
    });
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', ' ', 'arrowup', 'arrowdown'].includes(k)) e.preventDefault();
      if (k === 'arrowleft' || k === 'a') this.keys.left = true;
      if (k === 'arrowright' || k === 'd') this.keys.right = true;
      if (e.repeat) return;
      if (k === 'm') this.sound.toggleMute();
      if (k === 'p' || k === 'escape') this.togglePause();
      if (k === ' ' || k === 'enter') {
        this.sound.unlock();
        if (this.state === STATE.MENU || (this.state === STATE.GAMEOVER && this.stateTime > 0.6)) this.start();
        else if (this.state === STATE.PAUSED) this.togglePause();
      }
    });
    window.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') this.keys.left = false;
      if (k === 'arrowright' || k === 'd') this.keys.right = false;
    });
    // Auto-pause when tab loses focus; clear stuck keys.
    window.addEventListener('blur', () => {
      this.keys.left = this.keys.right = false;
      if (this.state === STATE.PLAYING) this.setState(STATE.PAUSED);
    });
  }
  inButton(x, y) { return Math.abs(x - CONFIG.W / 2) < 100 && y > 385 && y < 445; }
  // On-screen pause / mute buttons (phones have no P or M key).
  hitPause(x, y) { return Math.hypot(x - (CONFIG.W / 2 - 28), y - 30) < 24; }
  hitMute(x, y)  { return Math.hypot(x - (CONFIG.W / 2 + 28), y - 30) < 24; }

  /* ------------------------------ resize -------------------------------- */
  // Phone rotated: switch logical size and remap everything already on screen.
  applyLayout(name) {
    const ox = CONFIG.W, oy = CONFIG.H;
    this.layout = name; Object.assign(CONFIG, LAYOUTS[name]);
    const fx = CONFIG.W / ox, fy = CONFIG.H / oy;
    this.nest.rimY = CONFIG.H - CONFIG.NEST_Y_OFFSET;
    this.nest.x *= fx; this.nest.targetX *= fx;
    this.nest.targetX = clamp(this.nest.targetX, this.nest.w / 2, CONFIG.W - this.nest.w / 2);
    this.nest.x = clamp(this.nest.x, this.nest.w / 2, CONFIG.W - this.nest.w / 2);
    this.hen.x *= fx;
    for (const e of this.eggs) { e.x *= fx; e.y *= fy; }
    for (const c of this.clouds) { c.x *= fx; c.y *= fy; }
    this.particles.reset();
    if (this.state === STATE.PLAYING) this.setState(STATE.PAUSED);   // give the player a moment
  }

  // Fit canvas into the window keeping the aspect ratio; sharp on HiDPI.
  resize() {
    const want = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
    if (want !== this.layout) this.applyLayout(want);
    const scale = Math.min(window.innerWidth / CONFIG.W, window.innerHeight / CONFIG.H);
    const cssW = Math.floor(CONFIG.W * scale), cssH = Math.floor(CONFIG.H * scale);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = cssW + 'px'; this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    this.pxScale = this.canvas.width / CONFIG.W;
  }

  /* ----------------------------- main loop ------------------------------ */
  frame(now) {
    // Delta-time in seconds; clamped so a background tab doesn't cause a huge jump.
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.update(dt);
    this.draw();
    requestAnimationFrame(t => this.frame(t));
  }

  update(dt) {
    this.stateTime += dt;
    // Clouds always drift (even in menu/pause looks alive, except paused)
    if (this.state !== STATE.PAUSED) {
      for (const c of this.clouds) { c.x += c.v * dt; if (c.x > CONFIG.W + 100) c.x = -100; }
    }
    if (this.state === STATE.MENU) { this.hen.update(dt, 0); this.hen.dropTimer = 99; return; }
    if (this.state === STATE.PAUSED) return;

    this.particles.update(dt);
    if (this.state === STATE.GAMEOVER) { this.updateEggs(dt); return; }

    // --- PLAYING ---
    this.nest.update(dt, this.keys);
    if (this.hen.update(dt, this.level)) this.spawnEgg();
    // One rainbow egg per minute of actual play (timer doesn't run while paused/menu).
    this.rainbowTimer -= dt;
    if (this.rainbowTimer <= 0) {
      this.rainbowTimer += CONFIG.RAINBOW_INTERVAL;
      this.eggs.push(new Egg(this.hen.x, this.hen.y + 24, 'rainbow'));
    }
    this.updateEggs(dt);
  }

  spawnEgg() {
    const r = Math.random();
    const type = r < CONFIG.GOLDEN_CHANCE ? 'golden'
               : r < CONFIG.GOLDEN_CHANCE + CONFIG.ROTTEN_CHANCE ? 'rotten' : 'normal';
    this.eggs.push(new Egg(this.hen.x, this.hen.y + 24, type));
  }

  updateEggs(dt) {
    const groundY = CONFIG.H - CONFIG.GROUND_H;
    for (const egg of this.eggs) {
      const prevBottom = egg.bottom;
      egg.update(dt, this.gravity);
      if (this.state !== STATE.PLAYING) {                       // game over: let eggs fall, no scoring
        if (egg.bottom >= groundY) egg.dead = true;
        continue;
      }
      // CATCH: the egg's bottom crosses the nest rim line this frame while its x is inside the opening.
      // Using "crossing" (prev above rim, now at/below) avoids tunnelling at high speed
      // and ensures each egg is judged exactly once.
      if (!egg.passedRim && prevBottom < this.nest.rimY && egg.bottom >= this.nest.rimY) {
        if (this.nest.contains(egg.x)) { this.catchEgg(egg); continue; }
        egg.passedRim = true;                                    // missed the opening; keeps falling
      }
      // MISS: reached the ground
      if (egg.bottom >= groundY) this.missEgg(egg, groundY);
    }
    this.eggs = this.eggs.filter(e => !e.dead);
  }

  catchEgg(egg) {
    egg.dead = true;
    this.nest.pop();
    const y = this.nest.rimY;
    if (egg.type === 'rainbow') {
      this.score += CONFIG.RAINBOW_POINTS;
      for (const col of ['#ff3b3b', '#ffe135', '#3ddc5a', '#3aa0ff', '#8a4dff']) this.particles.burst(egg.x, y, col, 8);
      this.particles.text(egg.x, y - 20, '+' + CONFIG.RAINBOW_POINTS, '#ff8bd8');
      this.sound.rainbow();
    } else if (egg.type === 'rotten') {                          // rotten: lose a life
      this.particles.burst(egg.x, y, '#4f7a2a', 14);
      this.particles.text(egg.x, y - 20, '-1 ♥', '#9be564');
      this.sound.rotten();
      this.loseLife();
    } else if (egg.type === 'golden') {
      this.score += CONFIG.GOLDEN_POINTS;
      this.particles.burst(egg.x, y, '#ffd700', 24);
      this.particles.text(egg.x, y - 20, '+' + CONFIG.GOLDEN_POINTS, '#ffd700');
      this.sound.golden();
    } else {
      this.score += 1;
      this.particles.burst(egg.x, y, '#fff6d6', 12);
      this.particles.text(egg.x, y - 20, '+1', '#ffffff');
      this.sound.catch();
    }
  }

  missEgg(egg, groundY) {
    egg.dead = true;
    if (egg.type === 'rotten' || egg.type === 'rainbow') {       // rotten: harmless; rainbow: just a missed bonus, no life lost
      this.particles.splat(egg.x, groundY + 4, egg.type === 'rainbow' ? '#ff8bd8' : '#4f7a2a');
      return;
    }
    this.particles.splat(egg.x, groundY + 4, egg.type === 'golden' ? '#ffd700' : '#ffd84a');
    this.sound.miss();
    this.loseLife();
  }

  loseLife() {
    if (this.state !== STATE.PLAYING) return;
    this.lives = Math.max(0, this.lives - 1);
    if (this.lives === 0) this.gameOver();
  }

  gameOver() {
    this.setState(STATE.GAMEOVER);
    if (this.score > this.highScore) {
      this.highScore = this.score; this.newHigh = true;
      try { localStorage.setItem('eggCatcherHigh', String(this.highScore)); } catch (e) {}
    }
    this.sound.over();
  }

  /* ------------------------------ drawing ------------------------------- */
  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);   // draw in logical coordinates
    this.drawBackground(ctx);
    this.particles.draw(ctx);                                   // splats sit on the ground
    for (const e of this.eggs) e.draw(ctx);
    if (this.state !== STATE.MENU) this.nest.draw(ctx);
    this.hen.draw(ctx);
    if (this.state !== STATE.MENU) this.drawHUD(ctx);
    if (this.state === STATE.MENU) this.drawMenu(ctx);
    if (this.state === STATE.PAUSED) this.drawOverlay(ctx, 'PAUSED', IS_TOUCH ? 'Tap to resume' : 'Press P, Space or click to resume');
    if (this.state === STATE.GAMEOVER) this.drawGameOver(ctx);
    if (this.sound.muted) { ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText('🔇 muted (M)', CONFIG.W - 12, CONFIG.H - 12); }
  }

  drawBackground(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, CONFIG.H);
    g.addColorStop(0, '#4aa3e8'); g.addColorStop(1, '#bfe6ff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, CONFIG.W, CONFIG.H);
    // clouds: three overlapping circles
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const c of this.clouds) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 22 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x + 24 * c.s, c.y - 8 * c.s, 28 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x + 52 * c.s, c.y, 20 * c.s, 0, Math.PI * 2);
      ctx.fill();
    }
    // ground strip
    const gy = CONFIG.H - CONFIG.GROUND_H;
    ctx.fillStyle = '#4caf50'; ctx.fillRect(0, gy, CONFIG.W, CONFIG.GROUND_H);
    ctx.fillStyle = '#388e3c'; ctx.fillRect(0, gy, CONFIG.W, 6);
  }

  drawHeart(ctx, x, y, s, filled) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.bezierCurveTo(-14, -4, -8, -14, 0, -7);
    ctx.bezierCurveTo(8, -14, 14, -4, 0, 6);
    ctx.closePath();
    ctx.fillStyle = filled ? '#e53935' : 'rgba(0,0,0,0.25)';
    ctx.fill(); ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  drawHUD(ctx) {
    ctx.textAlign = 'left'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px sans-serif';
    ctx.strokeText('Score: ' + this.score, 16, 36); ctx.fillText('Score: ' + this.score, 16, 36);
    ctx.font = 'bold 16px sans-serif';
    ctx.strokeText('Best: ' + this.highScore, 16, 58); ctx.fillText('Best: ' + this.highScore, 16, 58);
    ctx.strokeText('Level ' + (this.level + 1), 16, 78); ctx.fillText('Level ' + (this.level + 1), 16, 78);
    this.drawButtons(ctx);
    for (let i = 0; i < CONFIG.LIVES; i++) this.drawHeart(ctx, CONFIG.W - 28 - i * 34, 30, 1.3, i < this.lives);
  }

  drawButtons(ctx) {
    const cx = CONFIG.W / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (const x of [cx - 28, cx + 28]) { ctx.beginPath(); ctx.arc(x, 30, 20, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff';
    if (this.state === STATE.PAUSED) {                          // play triangle
      ctx.beginPath(); ctx.moveTo(cx - 33, 20); ctx.lineTo(cx - 33, 40); ctx.lineTo(cx - 17, 30); ctx.fill();
    } else { ctx.fillRect(cx - 35, 21, 6, 18); ctx.fillRect(cx - 25, 21, 6, 18); }
    ctx.font = '18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(this.sound.muted ? '🔇' : '🔊', cx + 28, 37);
  }

  drawOverlay(ctx, title, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, CONFIG.W, CONFIG.H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.font = 'bold 56px sans-serif'; ctx.fillText(title, CONFIG.W / 2, 270);
    ctx.font = '22px sans-serif'; ctx.fillText(sub, CONFIG.W / 2, 315);
  }

  drawMenu(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, CONFIG.W, CONFIG.H);
    ctx.textAlign = 'center';
    const small = CONFIG.W < 600;
    ctx.font = (small ? 'bold 34px' : 'bold 52px') + ' sans-serif'; ctx.lineWidth = 8; ctx.strokeStyle = '#a0521c';
    ctx.strokeText('asifinte motta pidetham', CONFIG.W / 2, 240); ctx.fillStyle = '#ffe27a'; ctx.fillText('asifinte motta pidetham', CONFIG.W / 2, 240);
    ctx.fillStyle = '#fff';
    const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 300);
    ctx.globalAlpha = pulse; ctx.font = 'bold 28px sans-serif';
    ctx.fillText(IS_TOUCH ? 'Tap to start' : 'Click or press Space to start', CONFIG.W / 2, 330); ctx.globalAlpha = 1;
    ctx.font = '17px sans-serif';
    if (IS_TOUCH) ctx.fillText('Drag your finger to move the nest', CONFIG.W / 2, 380);
    else ctx.fillText(small ? 'Move: mouse / ← → / A D' : 'Move: mouse / touch / ← → / A D    Pause: P    Mute: M', CONFIG.W / 2, 380);
    ctx.fillText('Gold egg +5   •   Rainbow egg +10 (every minute)', CONFIG.W / 2, 408);
    ctx.fillText('Green egg = rotten, don\'t catch it!', CONFIG.W / 2, 432);
    if (this.highScore) ctx.fillText('High score: ' + this.highScore, CONFIG.W / 2, 470);
  }

  drawGameOver(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, CONFIG.W, CONFIG.H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.font = 'bold 60px sans-serif'; ctx.fillText('Game Over', CONFIG.W / 2, 200);
    ctx.font = '30px sans-serif'; ctx.fillText('Score: ' + this.score, CONFIG.W / 2, 260);
    ctx.fillStyle = this.newHigh ? '#ffd700' : '#fff';
    ctx.fillText((this.newHigh ? 'New high score: ' : 'High score: ') + this.highScore, CONFIG.W / 2, 305);
    // Play Again button
    ctx.fillStyle = '#43a047'; ctx.strokeStyle = '#1b5e20'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.roundRect(CONFIG.W / 2 - 100, 385, 200, 60, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif'; ctx.fillText('Play Again', CONFIG.W / 2, 425);
    if (!IS_TOUCH) { ctx.font = '16px sans-serif'; ctx.fillText('or press Space / Enter', CONFIG.W / 2, 475); }
  }
}

window.__eggGame = new Game(document.getElementById('game'));
