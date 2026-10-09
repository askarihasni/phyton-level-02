/* ============================================================================
   MINI RPG BATTLE ARENA — script.js
   ----------------------------------------------------------------------------
   Architecture (advanced JS OOP for academic requirements):
     Character (base)      — encapsulation via #private fields, takeDamage(),
                             isAlive(), polymorphic attack()
       ├─ Hero             — mana, stamina, combos, heal(), stance (block/
       │                      dodge/crouch), ultimate special
       └─ Monster          — enrage() once-only, AI weights, personality
     CombatSystem          — data-driven move registry, damage/crit/block/
                             dodge resolution (no giant if/else blocks)
     AnimationSystem       — named animation states, single-flight, always
                             returns to idle, no conflicting animations
     EnemyAI               — weighted situational decisions per monster style
     UIController          — ALL DOM updates live here (game logic stays pure)
     GameController        — explicit state machine + turn flow
   ----------------------------------------------------------------------------
   PRESERVED FROM THE ORIGINAL PROJECT: chroma-keyed sprite pipeline,
   FighterSprite frame-swap + pose tweening, ParticleFX, screen shake,
   impact text, recoil/knockback reactions, 3-round gauntlet structure.
   ========================================================================== */

/* ============================== UTILITIES ================================ */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const Ease = {
    linear: t => t,
    outQuad: t => 1 - (1 - t) * (1 - t),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inCubic: t => t * t * t,
    outQuart: t => 1 - Math.pow(1 - t, 4),
    inOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
};

const tween = (duration, onUpdate, easing = Ease.linear) => new Promise(resolve => {
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        onUpdate(easing(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
    };
    requestAnimationFrame(step);
});

/* ============================== GAME STATES ============================== */
const GameState = Object.freeze({
    START: 'START',
    PLAYER_TURN: 'PLAYER_TURN',
    ENEMY_TURN: 'ENEMY_TURN',
    ANIMATING: 'ANIMATING',
    ROUND_TRANSITION: 'ROUND_TRANSITION',
    VICTORY: 'VICTORY',
    DEFEAT: 'DEFEAT',
    GAME_OVER: 'GAME_OVER'
});

/* ============================ DOM REFERENCES ============================= */
// Cached once — no repeated queries in hot paths (performance requirement).
const UI = {
    hero: {
        name: document.getElementById('hero-name'),
        level: document.getElementById('hero-level'),
        healthBar: document.getElementById('hero-health'),
        healthValue: document.getElementById('hero-health-value'),
        manaBar: document.getElementById('hero-mana'),
        manaValue: document.getElementById('hero-mana-value'),
        staminaBar: document.getElementById('hero-stamina'),
        staminaValue: document.getElementById('hero-stamina-value'),
        canvas: document.getElementById('hero-canvas')
    },
    monster: {
        name: document.getElementById('monster-name'),
        level: document.getElementById('monster-level'),
        portrait: document.getElementById('monster-portrait'),
        healthBar: document.getElementById('monster-health'),
        healthValue: document.getElementById('monster-health-value'),
        staminaBar: document.getElementById('monster-stamina'),
        staminaValue: document.getElementById('monster-stamina-value'),
        canvas: document.getElementById('monster-canvas')
    },
    controls: {
        jab: document.getElementById('jab-btn'),
        punch: document.getElementById('punch-btn'),
        heavyPunch: document.getElementById('heavy-punch-btn'),
        uppercut: document.getElementById('uppercut-btn'),
        frontKick: document.getElementById('front-kick-btn'),
        lowKick: document.getElementById('low-kick-btn'),
        roundhouse: document.getElementById('roundhouse-btn'),
        heavyKick: document.getElementById('heavy-kick-btn'),
        block: document.getElementById('block-btn'),
        dodge: document.getElementById('dodge-btn'),
        crouch: document.getElementById('crouch-btn'),
        heal: document.getElementById('heal-btn'),
        special: document.getElementById('special-btn'),
        panel: document.getElementById('controls')
    },
    log: { list: document.getElementById('log-list') },
    overlay: {
        container: document.getElementById('overlay'),
        message: document.getElementById('overlay-message'),
        sub: document.getElementById('overlay-sub'),
        stats: document.getElementById('victory-stats'),
        restartBtn: document.getElementById('restart-btn')
    },
    stats: {
        rounds: document.getElementById('stat-rounds'),
        damage: document.getElementById('stat-damage'),
        crits: document.getElementById('stat-crits'),
        enemies: document.getElementById('stat-enemies')
    },
    timer: document.getElementById('timer'),
    turnIndicator: document.getElementById('turn-indicator'),
    combo: document.getElementById('combo-display'),
    roundBanner: document.getElementById('round-banner'),
    damageLayer: document.getElementById('damage-numbers'),
    gameContainer: document.getElementById('game-container'),
    fxCanvas: document.getElementById('fx-canvas')
};

/* ============================== SOUND FX ================================ */
// Synthesized with WebAudio (no external/copyrighted assets needed).
// The game is fully playable if audio is unavailable.
const SoundFX = {
    ctx: null,
    enabled: true,
    ensure() {
        if (!this.ctx) {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (AC) this.ctx = new AC();
            } catch (e) { this.enabled = false; }
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return this.ctx;
    },
    tone(freq, dur, type = 'sine', vol = 0.18, slideTo = null) {
        if (!this.enabled) return;
        const ctx = this.ensure();
        if (!ctx) return;
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
            gain.gain.setValueAtTime(vol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + dur);
        } catch (e) { /* audio must never break the game */ }
    },
    noise(dur, vol = 0.2, filterFreq = 900) {
        if (!this.enabled) return;
        const ctx = this.ensure();
        if (!ctx) return;
        try {
            const len = Math.floor(ctx.sampleRate * dur);
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = filterFreq;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(vol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
            src.connect(filter).connect(gain).connect(ctx.destination);
            src.start();
        } catch (e) { /* ignore */ }
    },
    click()   { this.tone(660, 0.06, 'square', 0.06); },
    jab()     { this.noise(0.07, 0.14, 2200); this.tone(220, 0.06, 'square', 0.10); },
    punch()   { this.noise(0.10, 0.20, 1500); this.tone(160, 0.10, 'square', 0.14, 70); },
    kick()    { this.noise(0.14, 0.24, 1100); this.tone(120, 0.14, 'sawtooth', 0.16, 55); },
    heavy()   { this.noise(0.22, 0.30, 800); this.tone(90, 0.24, 'sawtooth', 0.22, 40); },
    crit()    { this.noise(0.24, 0.32, 1400); this.tone(420, 0.28, 'square', 0.18, 90); },
    block()   { this.tone(340, 0.09, 'triangle', 0.16, 240); this.noise(0.06, 0.10, 3000); },
    dodge()   { this.tone(700, 0.14, 'sine', 0.10, 1400); },
    heal()    { this.tone(520, 0.16, 'sine', 0.14, 780); this.tone(780, 0.22, 'sine', 0.10, 1040); },
    special() { this.tone(140, 0.5, 'sawtooth', 0.22, 900); this.noise(0.35, 0.25, 1200); },
    enrage()  { this.tone(110, 0.5, 'sawtooth', 0.24, 55); },
    victory() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 'triangle', 0.16), i * 130)); },
    defeat()  { [400, 320, 240, 160].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'sawtooth', 0.14), i * 170)); },
    ko()      { this.tone(200, 0.6, 'square', 0.2, 45); }
};

/* ========================= SPRITE PIPELINE ============================== */
// (Preserved from original: green-screen removal + cached keyed frames.)
const FIGHTER_FRAMES = {
    idle: 'assets/fighter.jpg',
    kick: 'assets/fighter_kick.jpg',
    punch: 'assets/fighter_punch.jpg'
};
const SPRITE_WIDTH = 400;
const spriteCache = new Map();

function loadKeyedSprite(imgSrc) {
    if (spriteCache.has(imgSrc)) return spriteCache.get(imgSrc);
    const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.src = imgSrc;
        img.onerror = reject;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = SPRITE_WIDTH;
            const ratio = img.height / img.width;
            canvas.height = SPRITE_WIDTH * ratio;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const l = frame.data.length / 4;
            for (let i = 0; i < l; i++) {
                const r = frame.data[i * 4 + 0];
                const g = frame.data[i * 4 + 1];
                const b = frame.data[i * 4 + 2];
                if (g > 150 && g > r * 1.5 && g > b * 1.5) frame.data[i * 4 + 3] = 0;
            }
            ctx.putImageData(frame, 0, 0);
            resolve(canvas);
        };
    });
    spriteCache.set(imgSrc, promise);
    return promise;
}

function applyFighterFilter(canvas, hueRotate = 0, extra = '', layers = []) {
    const filter = hueRotate !== 0
        ? `drop-shadow(10px 20px 10px rgba(0,0,0,0.8)) hue-rotate(${hueRotate}deg) ${extra}`
        : `drop-shadow(10px 20px 10px rgba(0,0,0,0.8)) ${extra}`;
    canvas.style.filter = filter;
    // Rig overlay layers (head / front-arm) must share the fighter's look.
    for (const L of layers) if (L) L.style.filter = filter;
}

/* ------------------- RIG OVERLAY LAYERS (Phase 2) ----------------------- */
// Body-part rig: the shared idle/punch keyed art has its FRONT-ARM region
// erased (RIG_ERASED) so a dynamic arm overlay is the only arm on screen.
// The head layer sits over the original head and gives facial reactions via
// small-angle snaps. Kicks use the airborne keyed frame, so both layers are
// hidden whenever frame === 'kick' (the art is a different composition).
// Overlay transforms are baked into the canvas draw (rotate about the joint
// pivot) — the DOM elements themselves mirror the fighter's inline pose.
const RIG_PARTS = {
    head: { clip: [186, 15, 62, 61], pivot: [215, 73] },   // face / helmet region
    arm:  { clip: [250, 66, 123, 93], pivot: [252, 80] }   // front arm span
};
// Arm polygon minus the body-kept shoulder/bridge zone: the keyed art's only
// arm↔torso attachment is the bridge at y114-158 (x260-300) plus the punch
// frame's shoulder strip (x250-260, y86-114). Keeping those pixels on the
// body canvas means windup/recovery rotations can never vacate the joint —
// the arm stays attached at every pose (rotation shows as an art-on-art
// crease, never a background crack).
const RIG_POLY = [[250, 66], [372, 66], [372, 158], [300, 158], [300, 114], [260, 114], [260, 86], [250, 86]];
const RIG_ERASED = new Set(['idle', 'punch']);

function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

/* ---------- FighterSprite: frame swapping + pose transform + rig ---------- */
class FighterSprite {
    constructor(canvas, side) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { willReadFrequently: true });
        this.side = side;                     // 'hero' | 'monster'
        this.flipped = side === 'monster';    // monster art faces left
        this.frames = {};
        this.currentFrame = null;
        this.loaded = false;
        this.reactToken = 0;                  // invalidates stale reactions
        this.poseString = '';
        this.rig = {};                        // { head, arm } layer canvases
        this._partAngles = {};
        this._partOffsets = {};
        this._buildRig();
    }

    // Overlay layers live as DOM siblings of the fighter canvas and carry the
    // same side classes, so they inherit identical positioning + CSS flip.
    _buildRig() {
        if (!this.canvas.parentElement) return;
        const sideCls = this.flipped ? 'monster-fighter' : 'hero-fighter';
        for (const part of Object.keys(RIG_PARTS)) {
            const layer = document.createElement('canvas');
            layer.width = 400;
            layer.height = 400;
            layer.className = `rig-layer rig-${part} fighter ${sideCls}`;
            layer.classList.add('hidden');
            this.canvas.parentElement.appendChild(layer);
            this.rig[part] = layer;
        }
        // Floor shadow: a grounded ellipse that sits under the fighter and
        // never moves with the inline pose (fights 'float' above it).
        const shadowHost = document.createElement('div');
        shadowHost.className = `fighter-shadow ${this.flipped ? 'monster-shadow' : 'hero-shadow'}`;
        const ellipse = document.createElement('div');
        ellipse.className = 'shadow-ellipse';
        shadowHost.appendChild(ellipse);
        this.canvas.parentElement.appendChild(shadowHost);
        this.shadow = shadowHost;
    }

    // Trace one overlay part with the arm's exact polygon so rotating it never
    // drags torso pixels (the arm clip rect is wider than the limb itself).
    _tracePolygon(ctx) {
        ctx.beginPath();
        ctx.moveTo(RIG_POLY[0][0], RIG_POLY[0][1]);
        for (let i = 1; i < RIG_POLY.length; i++) ctx.lineTo(RIG_POLY[i][0], RIG_POLY[i][1]);
        ctx.closePath();
        ctx.clip();
    }

    // Punch a transparent hole where an overlay layer will sit so the rigged
    // head/arm are the ONLY source of those pixels. Applied to THIS canvas on
    // every grounded draw — the shared keyed frames stay pristine for the
    // overlay layers to cut from.
    _eraseRiggedRegions() {
        try {
            // The airborne kick frame is composed on its own (layers hidden) —
            // never carve holes into it.
            if (this.currentFrame === 'kick') return;
            const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const d = img.data, w = this.canvas.width;
            const clear = (x0, y0, x1, y1) => {
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) d[(y * w + x) * 4 + 3] = 0;
                }
            };
            // arm polygon (idle/punch frames — the kick frame is its own body)
            if (RIG_ERASED.has(this.currentFrame)) {
                for (let y = 66; y <= 158; y++) {
                    for (let x = 250; x <= 372; x++) {
                        if (pointInPoly(x, y, RIG_POLY)) d[(y * w + x) * 4 + 3] = 0;
                    }
                }
            }
            // head clip rect — the rigged head layer is its only visible source
            // Inclusive bounds must match the head layer's drawImage coverage
            // (clip rect w/h), or a 1px seam of lost art appears at rest.
            const h = RIG_PARTS.head.clip;
            clear(h[0], h[1], h[0] + h[2] - 1, h[1] + h[3] - 1);
            this.ctx.putImageData(img, 0, 0);
        } catch (e) { /* rig erasure is cosmetic — never fatal */ }
    }

    async load(frameSrcs) {
        const entries = await Promise.all(
            Object.entries(frameSrcs).map(async ([name, src]) => [name, await loadKeyedSprite(src)])
        );
        this.frames = Object.fromEntries(entries);
        this.canvas.width = this.frames.idle.width;
        this.canvas.height = this.frames.idle.height;
        this.currentFrame = null;
        this.setFrame('idle');
        this.resetPose();
        this.loaded = true;
    }

    setFrame(name) {
        if (this.currentFrame === name || !this.frames[name]) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.frames[name], 0, 0, this.canvas.width, this.canvas.height);
        this.currentFrame = name;
        this._eraseRiggedRegions();
        for (const part of Object.keys(RIG_PARTS)) this._redrawPart(part, name);
    }

    // Re-render one overlay part from the current keyed frame, rotating about
    // its joint pivot and applying the part's own offset (baked into the draw).
    _redrawPart(part, name) {
        const layer = this.rig[part];
        const frame = this.frames[name];
        if (!layer || !frame) return;
        const cfg = RIG_PARTS[part];
        const ctx = layer.getContext('2d');
        ctx.save();
        ctx.clearRect(0, 0, layer.width, layer.height);
        if (name === 'kick') { layer.classList.add('hidden'); ctx.restore(); return; }
        layer.classList.remove('hidden');
        const deg = this._partAngles[part] || 0;
        const off = this._partOffsets[part] || { x: 0, y: 0 };
        if (part === 'arm' && name === 'idle') {
            // Idle arm rests against a horizontal shoulder junction (y=114).
            // A rigid rotation about any single pivot would open a background
            // slit on one side of that line (lift = (x-px)*sinθ). A horizontal
            // shear about y=114 keeps y invariant, so the arm's bottom edge
            // stays exactly coincident with the body-kept strip at every angle —
            // attachment is guaranteed by construction. off.y is intentionally
            // dropped here (a vertical lift would tear the junction open);
            // off.x still slides the arm along the shoulder.
            const gamma = -Math.sin(deg * Math.PI / 180);
            // x' = x + gamma*(y-114), y' = y  ->  a=1, b=0, c=gamma, d=1,
            // e = -gamma*114, f = 0 (e is the x-translation, f the y one).
            // setTransform (not transform) keeps this portable to the canvas
            // shim used by the headless suites, which implements setTransform.
            ctx.setTransform(1, 0, gamma, 1, -gamma * 114, 0);
            ctx.translate(off.x, 0);
        } else {
            ctx.translate(cfg.pivot[0] + off.x, cfg.pivot[1] + off.y);
            ctx.rotate(deg * Math.PI / 180);
            ctx.translate(-cfg.pivot[0], -cfg.pivot[1]);
        }
        // Clip AFTER the joint transform so the polygon rotates with the arm.
        if (part === 'arm') this._tracePolygon(ctx);
        ctx.drawImage(frame, cfg.clip[0], cfg.clip[1], cfg.clip[2], cfg.clip[3],
            cfg.clip[0], cfg.clip[1], cfg.clip[2], cfg.clip[3]);
        ctx.restore();
    }

    // Repose a single overlay part (degrees of rotation + pixel offset).
    setRigPart(part, opts = {}) {
        if (!this.rig[part]) return;
        this._partAngles[part] = opts.deg || 0;
        this._partOffsets[part] = { x: opts.x || 0, y: opts.y || 0 };
        this._redrawPart(part, this.currentFrame || 'idle');
    }

    _poseString(x, y, sx, sy, r) {
        const base = this.flipped ? 'scaleX(-1) ' : '';
        const rot = r ? `rotate(${r}deg) ` : '';
        return `${base}translate(${x}px, ${y}px) ${rot}scale(${sx}, ${sy})`;
    }

    // x > 0 always means "toward the opponent" (flip handles direction).
    // r = rotation in degrees (for uppercut / roundhouse body torque).
    setPose(x = 0, y = 0, sx = 1, sy = 1, r = 0) {
        this.poseString = this._poseString(x, y, sx, sy, r);
        this.canvas.style.transform = this.poseString;
        this._applyTransforms();
    }

    resetPose() {
        this.poseString = '';
        this.canvas.style.transform = '';
        this._applyTransforms();
    }

    _applyTransforms() {
        for (const part of Object.keys(RIG_PARTS)) {
            const layer = this.rig[part];
            if (layer) layer.style.transform = this.poseString;
        }
    }

    resetRig() {
        for (const part of Object.keys(RIG_PARTS)) this.setRigPart(part, { deg: 0, x: 0, y: 0 });
    }
}

/* ============================ PARTICLE FX ================================ */
// (Preserved from original: sparks, dust, flash rings on a separate canvas.)
class ParticleFX {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.particles = [];
        this.running = false;
        this.lastTime = 0;
        this.resize();
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.width = this.canvas.clientWidth;
        this.height = this.canvas.clientHeight;
        this.canvas.width = this.width * dpr;
        this.canvas.height = this.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    burst(x, y, { dir = 1, sparks = 30, dust = 10, crit = false, hue = 28 } = {}) {
        const rand2 = (a, b) => a + Math.random() * (b - a);
        this.particles.push({ type: 'flash', x, y, age: 0, life: crit ? 220 : 160, maxR: crit ? 85 : 60 });

        for (let i = 0; i < sparks; i++) {
            const angle = rand2(-0.9, 0.9) + (dir > 0 ? 0 : Math.PI);
            const speed = rand2(3, crit ? 13 : 10);
            this.particles.push({
                type: 'spark', x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - rand2(0, 3),
                age: 0, life: rand2(250, 520),
                hue: rand2(hue, hue + 24), width: rand2(1.5, 3)
            });
        }
        for (let i = 0; i < dust; i++) {
            this.particles.push({
                type: 'dust',
                x: x + rand2(-10, 10), y: y + rand2(-10, 10),
                vx: dir * rand2(0.3, 2.2), vy: rand2(-1.4, 0.4),
                age: 0, life: rand2(550, 900),
                r0: rand2(5, 10), r1: rand2(24, 40)
            });
        }

        if (!this.running) {
            this.running = true;
            this.lastTime = performance.now();
            requestAnimationFrame(t => this.loop(t));
        }
    }

    // Motion-trail slash: a curved arc swept between two points (kicks).
    slash(ax, ay, bx, by, { cp, hue = 45, width = 6, life = 260 } = {}) {
        this.particles.push({
            type: 'slash', ax, ay, bx, by,
            cp: cp || { x: (ax + bx) / 2, y: (ay + by) / 2 - 30 },
            hue, age: 0, life, width
        });
        if (!this.running) {
            this.running = true;
            this.lastTime = performance.now();
            requestAnimationFrame(t => this.loop(t));
        }
    }

    loop(now) {
        const dt = Math.min(50, now - this.lastTime);
        const k = dt / 16.67;
        this.lastTime = now;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        this.particles = this.particles.filter(p => (p.age += dt) < p.life);

        for (const p of this.particles) {
            const t = p.age / p.life;
            if (p.type === 'spark') {
                p.vy += 0.28 * k;
                p.vx *= Math.pow(0.96, k);
                p.x += p.vx * k;
                p.y += p.vy * k;
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = `hsla(${p.hue}, 100%, ${75 - t * 25}%, ${1 - t})`;
                ctx.lineWidth = p.width;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
                ctx.stroke();
            } else if (p.type === 'dust') {
                p.x += p.vx * k;
                p.y += p.vy * k;
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = `rgba(190, 175, 150, ${0.35 * (1 - t)})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, lerp(p.r0, p.r1, Ease.outQuad(t)), 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'flash') {
                const r = p.maxR * Ease.outCubic(t);
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, r));
                g.addColorStop(0, `rgba(255, 250, 220, ${0.9 * (1 - t)})`);
                g.addColorStop(0.4, `rgba(255, 170, 40, ${0.6 * (1 - t)})`);
                g.addColorStop(1, 'rgba(255, 80, 0, 0)');
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'slash') {
                // curved arc trail sweeping from behind the foot to the boot
                const reach = Ease.outQuad(clamp01(t / 0.4));
                const fade = 1 - t;
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = `hsla(${p.hue}, 100%, 72%, ${0.6 * fade})`;
                ctx.lineWidth = Math.max(1, p.width * (1 - reach * 0.7));
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(p.ax, p.ay);
                ctx.quadraticCurveTo(p.cp.x, p.cp.y, p.bx, p.by);
                ctx.stroke();
            }
        }
        ctx.globalCompositeOperation = 'source-over';

        if (this.particles.length) requestAnimationFrame(t => this.loop(t));
        else { this.running = false; ctx.clearRect(0, 0, this.width, this.height); }
    }

    destroy() { window.removeEventListener('resize', this._onResize); }
}

/* =========================== MOVE REGISTRY ============================== */
// Data-driven combat: every move carries damage, costs, accuracy, hit level
// and animation profile. Adding a move = adding an entry (scalable, no
// giant if/else blocks anywhere in the combat code).
const MOVES = {
    jab: {
        kind: 'attack', label: 'Jab', frame: 'punch', anim: 'jab',
        multiplier: 0.7, accuracy: 0.98, staminaCost: 5, hitLevel: 'high',
        critChance: 0.12, sfx: ['POW!', 'SNAP!', 'TAP!'], sound: 'jab'
    },
    punch: {
        kind: 'attack', label: 'Straight Punch', frame: 'punch', anim: 'punch',
        multiplier: 1.0, accuracy: 0.95, staminaCost: 8, hitLevel: 'mid',
        critChance: 0.10, sfx: ['POW!', 'WHAM!', 'SMACK!'], sound: 'punch'
    },
    heavyPunch: {
        kind: 'attack', label: 'Heavy Punch', frame: 'punch', anim: 'heavyPunch',
        multiplier: 1.5, accuracy: 0.88, staminaCost: 15, hitLevel: 'mid',
        critChance: 0.12, sfx: ['KRAK!', 'BOOM!', 'WHAM!'], sound: 'heavy'
    },
    uppercut: {
        kind: 'attack', label: 'Uppercut', frame: 'punch', anim: 'uppercut',
        multiplier: 1.7, accuracy: 0.85, staminaCost: 18, hitLevel: 'high',
        critChance: 0.15, sfx: ['UPPERCUT!', 'SKY HIGH!', 'KRAK!'], sound: 'heavy'
    },
    frontKick: {
        kind: 'attack', label: 'Front Kick', frame: 'kick', anim: 'frontKick',
        multiplier: 1.1, accuracy: 0.92, staminaCost: 12, hitLevel: 'mid',
        critChance: 0.10, sfx: ['THUD!', 'BAM!', 'WHUMP!'], sound: 'kick'
    },
    lowKick: {
        kind: 'attack', label: 'Low Kick', frame: 'kick', anim: 'lowKick',
        multiplier: 0.9, accuracy: 0.95, staminaCost: 10, hitLevel: 'low',
        critChance: 0.10, sfx: ['CRACK!', 'SNAP!', 'THWACK!'], sound: 'kick'
    },
    roundhouse: {
        kind: 'attack', label: 'Roundhouse Kick', frame: 'kick', anim: 'roundhouse',
        multiplier: 1.8, accuracy: 0.82, staminaCost: 22, hitLevel: 'high',
        critChance: 0.13, sfx: ['BAM!', 'CRACK!', 'BOOM!'], sound: 'kick'
    },
    heavyKick: {
        kind: 'attack', label: 'Heavy Kick', frame: 'kick', anim: 'heavyKick',
        multiplier: 2.2, accuracy: 0.75, staminaCost: 26, hitLevel: 'high',
        critChance: 0.15, sfx: ['KABOOM!', 'CRASH!', 'BOOM!'], sound: 'heavy'
    },
    special: {
        kind: 'attack', heroOnly: true, label: 'Ultimate Special', frame: 'kick', anim: 'special',
        multiplier: 2.6, accuracy: 0.90, staminaCost: 25, manaCost: 40, hitLevel: 'mid',
        critChance: 0.25, sfx: ['DESTROY!', 'ANNIHILATE!', 'DEVASTATE!'], sound: 'special'
    },
    block:  { kind: 'defend', stance: 'block',  label: 'Block',  staminaCost: 5,  anim: 'block' },
    dodge:  { kind: 'defend', stance: 'dodge',  label: 'Dodge',  staminaCost: 12, anim: 'dodge' },
    crouch: { kind: 'defend', stance: 'crouch', label: 'Crouch', staminaCost: 8,  anim: 'crouch' },
    heal:   { kind: 'utility', heroOnly: true,  label: 'Heal',   manaCost: 20, healAmount: 40, anim: 'heal' }
};

/* ------------------- Animation profiles (per-move feel) ------------------ */
// Same 3 source frames, different kinematics => visually distinct attacks.
// Coordinates are in sprite-canvas pixels (400 x 400).
const FIST = { x: 367, y: 82 };
const BOOT = { x: 361, y: 158 };

const ANIM_PROFILES = {
    // --- punches (grounded arm extension, hip drive, body lean) ---
    // armWind/armStrike drive the overlay arm layer: chamber -> extend -> snap.
    jab: { frame: 'punch', cls: 'is-punching', windupMs: 40, strikeMs: 55, holdMs: 90, recoverMs: 100, settleMs: 60,
           lunge: 16, dip: 2, rise: 0, rot: 0, windupX: -5, squashX: 0.99, squashY: 1.01,
           armWind: -16, armStrike: 4,
           anchor: 0, point: FIST, radius: 20, heavy: false },
    punch: { frame: 'punch', cls: 'is-punching', windupMs: 70, strikeMs: 75, holdMs: 160, recoverMs: 130, settleMs: 90,
           lunge: 30, dip: 4, rise: 0, rot: 0, windupX: -8, squashX: 0.98, squashY: 1.01,
           armWind: -24, armStrike: 8,
           anchor: 0, point: FIST, radius: 22, heavy: false },
    heavyPunch: { frame: 'punch', cls: 'is-punching', windupMs: 130, strikeMs: 95, holdMs: 200, recoverMs: 150, settleMs: 100,
           lunge: 46, dip: 6, rise: -2, rot: -3, windupX: -16, squashX: 0.965, squashY: 1.03,
           armWind: -32, armStrike: 12,
           anchor: 0, point: FIST, radius: 28, heavy: true },
    uppercut: { frame: 'punch', cls: 'is-punching', windupMs: 110, strikeMs: 115, holdMs: 150, recoverMs: 150, settleMs: 90,
           lunge: 24, dip: 14, rise: -34, rot: -7, windupX: -12, squashX: 1.02, squashY: 0.94,
           armWind: 44, armStrike: -38,
           anchor: 0, point: FIST, radius: 26, heavy: true, dipFirst: true },
    // --- kicks (planted support leg, lifting striking leg, hip rotation) ---
    frontKick: { frame: 'kick', cls: 'is-kicking', windupMs: 70, strikeMs: 95, holdMs: 170, recoverMs: 140, settleMs: 90,
           lunge: 42, lift: 26, rise: 0, rot: -3, windupX: -10, anchor: 46, point: BOOT, radius: 24, heavy: false },
    lowKick: { frame: 'kick', cls: 'is-kicking', windupMs: 60, strikeMs: 85, holdMs: 130, recoverMs: 130, settleMs: 80,
           lunge: 46, lift: 6, rise: 0, rot: 4, windupX: -9, anchor: 46, point: BOOT, radius: 24, heavy: false, low: true },
    roundhouse: { frame: 'kick', cls: 'is-kicking', windupMs: 120, strikeMs: 115, holdMs: 230, recoverMs: 170, settleMs: 110,
           lunge: 54, lift: 46, rise: 0, rot: -14, windupX: -14, anchor: 46, point: BOOT, radius: 30, heavy: true, spin: true, trail: true },
    heavyKick: { frame: 'kick', cls: 'is-kicking', windupMs: 160, strikeMs: 130, holdMs: 300, recoverMs: 190, settleMs: 120,
           lunge: 60, lift: 56, rise: 0, rot: -10, windupX: -18, anchor: 46, point: BOOT, radius: 34, heavy: true, trail: true },
    special: { frame: 'kick', cls: 'is-kicking', windupMs: 200, strikeMs: 120, holdMs: 340, recoverMs: 200, settleMs: 130,
           lunge: 66, lift: 62, rise: 0, rot: -16, windupX: -20, anchor: 46, point: BOOT, radius: 40, heavy: true, glow: true, trail: true }
};

/* ------------------ Defender hit-reaction presets ------------------------ */
// JS-driven tiered reactions (CSS keyframes would clobber inline poses).
// seq steps describe the out-and-back body sweep; x/r are signed so both a
// hero and a (CSS-flipped) monster recoil away from the attacker.
const REACTIONS = {
    light: { knockX: 12, headDeg: -8, restX: 0, restR: 0, recoverMs: 140,
             seq: [
                 { ms: 90, x: t => -lerp(0, 14, t), y: t => 0, r: t => -lerp(0, 4, t) },
                 { ms: 100, x: t => -lerp(14, 1, t), y: t => 0, r: t => -lerp(4, 0, t) }
             ] },
    low: { knockX: 8, headDeg: -10, restX: 0, restR: 0, recoverMs: 140,
           seq: [
               { ms: 80, x: t => -lerp(0, 10, t), y: t => lerp(0, 9, t), r: t => lerp(0, 3, t) },
               { ms: 90, x: t => -lerp(10, 0, t), y: t => lerp(9, 0, t), r: t => lerp(3, 0, t) }
           ] },
    heavy: { knockX: 26, headDeg: -16, restX: 0, restR: 0, recoverMs: 190,
             seq: [
                 { ms: 110, x: t => -lerp(0, 42, Ease.outCubic(t)), y: t => -lerp(0, 12, t), r: t => -lerp(0, 10, t), sy: t => 1 - 0.08 * t },
                 { ms: 170, x: t => -lerp(42, 4, Ease.outQuad(t)), y: t => lerp(-12, 0, t), r: t => -lerp(10, 2, t), sy: t => 1 - 0.08 * (1 - t) }
             ] },
    crit: { knockX: 34, headDeg: -22, restX: 0, restR: 0, recoverMs: 230,
            seq: [
                { ms: 120, x: t => -lerp(0, 58, Ease.outCubic(t)), y: t => -lerp(0, 18, t), r: t => -lerp(0, 14, t), sx: t => 1 + 0.1 * t, sy: t => 1 - 0.12 * t },
                { ms: 210, x: t => -lerp(58, 6, Ease.outQuad(t)), y: t => lerp(-18, 0, t), r: t => -lerp(14, 3, t), sx: t => 1 + 0.1 * (1 - t), sy: t => 1 - 0.12 * (1 - t) }
            ] },
    // Non-damaging outcomes: a tiny head settle is enough (FX handles the rest).
    dodge:   { knockX: 0, headDeg: 8, restX: 0, restR: 0, recoverMs: 120, seq: [] },
    crouch:  { knockX: 0, headDeg: 0, restX: 0, restR: 0, recoverMs: 100, seq: [] },
    block:   { knockX: 0, headDeg: -4, restX: 0, restR: 0, recoverMs: 90, seq: [] },
    whiff:   { knockX: 0, headDeg: 0, restX: 0, restR: 0, recoverMs: 60, seq: [] }
};

/* ======================== COMBAT RESOLUTION ============================= */
// Pure, DOM-free damage logic — testable independently of the UI.
const CombatSystem = {
    BLOCK_REDUCTION: 0.35,   // blocking never makes you invincible
    DODGE_CHANCE: 0.60,      // dodge can fail
    DODGE_PUNISH: 1.15,      // failed dodge takes extra damage
    CROUCH_HIGH: 0,          // high attacks whiff over a crouching fighter
    CROUCH_MID: 0.6,
    CROUCH_LOW: 1.25,        // low attacks punish crouchers

    // Defender-side resolution: applies stance, returns final numbers.
    resolveIncoming(defender, rawDamage, move) {
        const stance = defender.stance || 'idle';
        if (stance === 'dodge') {
            if (Math.random() < this.DODGE_CHANCE) return { damage: 0, dodged: true };
            return { damage: Math.round(rawDamage * this.DODGE_PUNISH), dodged: false, punished: true };
        }
        if (stance === 'block') {
            return { damage: Math.max(1, Math.round(rawDamage * this.BLOCK_REDUCTION)), blocked: true };
        }
        if (stance === 'crouch') {
            if (move.hitLevel === 'high') return { damage: 0, evaded: true };
            if (move.hitLevel === 'mid') return { damage: Math.round(rawDamage * this.CROUCH_MID), crouched: true };
            return { damage: Math.round(rawDamage * this.CROUCH_LOW), punished: true };
        }
        return { damage: rawDamage };
    },

    // Attacker-side resolution: accuracy roll + critical check.
    rollAttack(attacker, move) {
        if (Math.random() > move.accuracy) return { missed: true, damage: 0 };
        const isCritical = Math.random() < (move.critChance || 0.10);
        const base = Math.round(attacker.attackPower * attacker.getMoveMultiplier(move));
        return { missed: false, isCritical, raw: isCritical ? base * 2 : base };
    }
};

/* ============================= CHARACTERS =============================== */
class Character {
    #currentHealth;              // encapsulated — cannot be set from outside

    constructor(name, maxHealth, attackPower, level = 1) {
        this.name = name;
        this.maxHealth = maxHealth;
        this.#currentHealth = maxHealth;
        this.attackPower = attackPower;
        this.baseAttackPower = attackPower;   // for safe enrage calculations
        this.level = level;
        this.maxStamina = 100;
        this.currentStamina = 100;
        this.stance = 'idle';                 // 'idle' | 'block' | 'dodge' | 'crouch'
    }

    get currentHealth() { return this.#currentHealth; }

    // Health is clamped to [0, maxHealth] — never negative, never above max.
    takeDamage(amount) {
        const dmg = Math.max(0, Math.floor(amount));
        this.#currentHealth = Math.max(0, this.#currentHealth - dmg);
        return dmg;
    }

    restoreHealth(amount) {
        const healed = Math.max(0, Math.floor(amount));
        this.#currentHealth = Math.min(this.maxHealth, this.#currentHealth + healed);
        return this.#currentHealth;
    }

    isAlive() { return this.#currentHealth > 0; }

    get healthPercent() { return (this.#currentHealth / this.maxHealth) * 100; }

    // Override to modify outgoing damage (polymorphism).
    getMoveMultiplier(move) { return move.multiplier; }

    canSpend(move) {
        if (move.staminaCost && this.currentStamina < move.staminaCost) return false;
        if (move.manaCost && (this.currentMana ?? 0) < move.manaCost) return false;
        return true;
    }

    spend(move) {
        if (move.staminaCost) {
            this.currentStamina = Math.max(0, this.currentStamina - move.staminaCost);
        }
        if (move.manaCost) this.spendMana(move.manaCost);
    }

    // Mana pool hook — base characters have none; Hero overrides this.
    spendMana(/* amount */) { /* no mana pool */ }

    // POLYMORPHIC attack — different subclasses behave differently.
    //
    // Two-phase combat: prepareAttack() validates, spends resources and rolls
    // deterministically (all synchronous), returning a result whose apply()
    // defers the HP write. AnimationSystem calls result.apply() at the exact
    // visual impact moment so damage lands when the strike connects, not on
    // click. Costs are always spent at prepare time (never at impact).
    prepareAttack(target, moveKey = 'punch') {
        const move = MOVES[moveKey];
        if (!move || move.kind !== 'attack') return { invalid: true, damage: 0, missed: true };
        if (!this.isAlive() || !target || !target.isAlive()) return { invalid: true, damage: 0, missed: true };
        if (!this.canSpend(move)) {
            const reason = (move.staminaCost && this.currentStamina < move.staminaCost) ? 'stamina' : 'mana';
            return { failed: true, reason, damage: 0 };
        }

        this.spend(move);
        const roll = CombatSystem.rollAttack(this, move);
        if (roll.missed) {
            const miss = { missed: true, moveKey, damage: 0 };
            miss.apply = () => miss;   // damage-free — apply is a no-op
            return miss;
        }

        const resolved = CombatSystem.resolveIncoming(target, roll.raw, move);
        const prepared = { moveKey, damage: resolved.damage, isCritical: roll.isCritical, raw: roll.raw, ...resolved, applied: false };
        prepared.apply = () => {
            if (prepared.applied) return prepared;      // idempotent — never double-hit
            prepared.applied = true;
            prepared.damage = target.takeDamage(resolved.damage);
            return prepared;
        };
        return prepared;
    }

    // Compatibility wrapper — identical synchronous behaviour and result shape
    // to the original attack() (all tests and call sites keep working).
    attack(target, moveKey = 'punch') {
        const prepared = this.prepareAttack(target, moveKey);
        if (prepared.apply) return prepared.apply();
        return prepared;
    }

    regenStamina(amount) {
        this.currentStamina = Math.min(this.maxStamina, this.currentStamina + amount);
    }

    // Mana regeneration hook — base characters have none; Hero overrides.
    gainMana(/* amount */) { /* no mana pool */ }
}

/* ------------------------------- HERO ---------------------------------- */
class Hero extends Character {
    #currentMana;
    #comboCount = 0;

    constructor(name, maxHealth, attackPower, maxMana) {
        super(name, maxHealth, attackPower, 1);
        this.maxMana = maxMana;
        this.#currentMana = maxMana;
    }

    get currentMana() { return this.#currentMana; }
    get combo() { return this.#comboCount; }

    // Regenerate mana between turns (never exceeds max, never negative).
    gainMana(amount) {
        this.#currentMana = Math.min(this.maxMana, this.#currentMana + Math.max(0, amount));
    }

    registerHit() { this.#comboCount++; return this.#comboCount; }
    resetCombo() { this.#comboCount = 0; }

    // Combo bonus: +4% damage per consecutive hit, capped at +20%.
    getMoveMultiplier(move) {
        const bonus = Math.min(this.#comboCount * 0.04, 0.20);
        return move.multiplier * (1 + bonus);
    }

    // Override: mana cost is deducted from the private mana pool.
    spendMana(amount) {
        this.#currentMana = Math.max(0, this.#currentMana - amount);
    }

    // Healing restores HP but never exceeds maxHealth and consumes mana.
    // Fails gracefully when there isn't enough mana.
    heal() {
        const move = MOVES.heal;
        if (this.#currentMana < move.manaCost) {
            return { success: false, reason: 'Not enough mana!' };
        }
        if (!this.isAlive()) return { success: false, reason: 'You cannot heal while defeated.' };
        this.#currentMana -= move.manaCost;
        const before = this.currentHealth;
        this.restoreHealth(move.healAmount);
        return { success: true, healed: this.currentHealth - before };
    }

    useSpecial() {
        return this.attack(this._lastTarget, 'special'); // target injected by controller
    }
}

/* ------------------------------ MONSTER -------------------------------- */
class Monster extends Character {
    constructor(config) {
        super(config.name, config.hp, config.atk, config.level);
        this.hue = config.hue;
        this.portrait = config.portrait;
        this.style = config.style;            // 'aggressive' | 'heavy' | 'boss'
        this.moveSet = config.moveSet;
        this.maxStamina = 100;
        this.isEnraged = false;
    }

    // Enrage triggers ONCE below 30% HP: attack power is multiplied a single
    // time (guarded by isEnraged — never repeatedly multiplied every turn).
    enrage() {
        if (this.isEnraged) return false;
        this.isEnraged = true;
        this.attackPower = Math.round(this.baseAttackPower * 1.6);
        return true;
    }

    maybeEnrage() {
        if (this.isEnraged || !this.isAlive()) return false;
        if (this.healthPercent < 30) return this.enrage();
        return false;
    }

    // Polymorphic override: enraged monsters hit harder still.
    getMoveMultiplier(move) {
        return this.isEnraged ? move.multiplier * 1.15 : move.multiplier;
    }

    // Polymorphic override: monsters regenerate faster when hurt (desperation).
    regenStamina(amount) {
        const bonus = this.isEnraged ? 8 : 0;
        super.regenStamina(amount + bonus);
    }
}

/* ============================== ENEMY AI ================================ */
// Weighted, situational decisions — different monster styles behave
// differently, and the state of the fight changes the odds.
class EnemyAI {
    static chooseAction(monster, hero) {
        const entries = [];

        const add = (key, weight) => { if (weight > 0) entries.push([key, weight]); };

        // Base weights by personality.
        const styles = {
            aggressive: { jab: 14, punch: 16, lowKick: 10, frontKick: 12, roundhouse: 8, block: 4, dodge: 4, recover: 3 },
            heavy:      { punch: 12, heavyPunch: 14, lowKick: 8, frontKick: 10, roundhouse: 12, block: 5, dodge: 3, recover: 5 },
            boss:       { jab: 10, punch: 12, heavyPunch: 12, uppercut: 8, roundhouse: 10, heavyKick: 9, block: 8, dodge: 8, recover: 4 }
        };
        const base = styles[monster.style] || styles.aggressive;
        for (const [k, w] of Object.entries(base)) add(k, w);

        // Low own health: protect yourself + swing big to finish fast.
        if (monster.healthPercent < 30) {
            add('block', 12); add('dodge', 10); add('recover', 8);
            add('heavyPunch', 8); add('roundhouse', 8);
        }
        // Player is nearly dead: go aggressive.
        if (hero.healthPercent < 30) {
            add('jab', 8); add('punch', 8); add('heavyPunch', 10);
            add('roundhouse', 10); add('heavyKick', 8); add('uppercut', 6);
        }
        // Player is blocking: favour kicks / heavy blows that break guard.
        if (hero.stance === 'block') { add('roundhouse', 8); add('heavyPunch', 6); add('lowKick', 6); }
        // Player is crouching: punish with low attacks.
        if (hero.stance === 'crouch') { add('lowKick', 16); add('frontKick', 6); }
        // Player is dodging: fast attacks recover quicker.
        if (hero.stance === 'dodge') { add('jab', 10); add('punch', 6); }
        // Drained stamina: recover or turtle up.
        if (monster.currentStamina < 25) { add('recover', 20); add('block', 8); }

        // Filter to what the monster actually knows and can afford.
        const usable = entries.filter(([key, w]) => {
            if (key === 'recover') return monster.currentStamina < 80;
            if (!monster.moveSet.includes(key)) return false;
            const move = MOVES[key];
            return monster.canSpend(move);
        });
        if (!usable.length) return 'block';

        const total = usable.reduce((s, [, w]) => s + w, 0);
        let r = Math.random() * total;
        for (const [key, w] of usable) {
            r -= w;
            if (r <= 0) return key;
        }
        return usable[usable.length - 1][0];
    }
}

/* ========================== UI CONTROLLER =============================== */
// Every DOM write lives here — game logic never touches the DOM directly.
class UIController {
    constructor() {
        this.buttons = UI.controls;
        this._logCap = 60;
        this._bannerTimer = null;
        // Fighters must stand exactly on the control deck's top edge: the deck
        // height is measured (it changes per breakpoint) and exposed as the
        // --deck-h CSS var read by .fighter / .fighter-shadow / #combat-log.
        this.syncDeckHeight();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', () => this.syncDeckHeight());
        }
        // Fonts/wrapping can change the deck height after boot — watch it.
        if (typeof ResizeObserver === 'function' && UI.controls.panel) {
            this._deckRO = new ResizeObserver(() => this.syncDeckHeight());
            this._deckRO.observe(UI.controls.panel);
        }
    }

    syncDeckHeight() {
        const panel = UI.controls && UI.controls.panel;
        if (!panel || typeof panel.getBoundingClientRect !== 'function') return;
        const h = panel.getBoundingClientRect().height;
        if (!(h > 0)) return;
        const style = UI.gameContainer.style;
        const px = Math.round(h) + 'px';
        if (typeof style.setProperty === 'function') style.setProperty('--deck-h', px);
        else style['--deck-h'] = px;   // test-double fallback (plain object style)
    }

    setBar(el, valEl, current, max) {
        const pct = Math.max(0, Math.min(100, (current / max) * 100));
        el.style.width = `${pct}%`;
        if (valEl) valEl.textContent = `${Math.round(current)}/${max}`;
        return pct;
    }

    updateHUD(hero, monster) {
        const hpPct = this.setBar(UI.hero.healthBar, UI.hero.healthValue, hero.currentHealth, hero.maxHealth);
        this.setBar(UI.hero.manaBar, UI.hero.manaValue, hero.currentMana, hero.maxMana);
        this.setBar(UI.hero.staminaBar, UI.hero.staminaValue, hero.currentStamina, hero.maxStamina);
        UI.hero.healthBar.classList.toggle('low', hpPct <= 30);
        UI.hero.healthBar.classList.toggle('critical', hpPct <= 25);
        UI.hero.canvas.classList.toggle('low-hp', hpPct <= 25);
        UI.gameContainer.classList.toggle('player-low', hpPct <= 25);
        UI.hero.level.textContent = `Lv. ${hero.level}`;

        if (monster) {
            const mPct = this.setBar(UI.monster.healthBar, UI.monster.healthValue, monster.currentHealth, monster.maxHealth);
            this.setBar(UI.monster.staminaBar, UI.monster.staminaValue, monster.currentStamina, monster.maxStamina);
            UI.monster.healthBar.classList.toggle('low', mPct <= 30);
            UI.monster.healthBar.classList.toggle('critical', mPct <= 25);
            UI.monster.canvas.classList.toggle('low-hp', mPct <= 25);
            UI.monster.name.textContent = monster.name;
            UI.monster.level.textContent = `Lv. ${monster.level}`;
        }
    }

    setMonsterInfo(monster) {
        UI.monster.name.textContent = monster.name;
        UI.monster.level.textContent = `Lv. ${monster.level}`;
        if (monster.portrait) UI.monster.portrait.src = monster.portrait;
    }

    // Enables/disables every action button from current game state + resources.
    updateButtons(state, hero) {
        const playerTurn = state === GameState.PLAYER_TURN && hero && hero.isAlive();
        for (const [key, btn] of Object.entries(this.buttons)) {
            if (!btn || !btn.dataset.move) continue;
            const move = MOVES[btn.dataset.move];
            if (!move) continue;
            const affordable = !!(hero && hero.canSpend(move));
            let enabled = playerTurn && affordable;
            if (move.heroOnly && !affordable) enabled = false;
            btn.disabled = !enabled;
            // Distinguish "you can't afford this right now" during the player's
            // turn from the generic disabled look used off-turn / on game over.
            btn.classList.toggle('insufficient', playerTurn && !affordable);
        }
    }

    setTurn(text, enemy = false, visible = true) {
        UI.turnIndicator.textContent = text;
        UI.turnIndicator.classList.toggle('enemy-turn', enemy);
        UI.turnIndicator.classList.toggle('hidden', !visible);
    }

    setTimer(text) { UI.timer.textContent = text; }

    showCombo(count) {
        if (count >= 2) {
            UI.combo.textContent = `${count} HIT COMBO!`;
            UI.combo.classList.remove('hidden');
            // combo milestones — reached consecutive hits escalate the flash
            UI.combo.classList.toggle('milestone', count >= 5);
            UI.combo.classList.toggle('milestone-max', count >= 8);
            // restart the pop animation
            UI.combo.style.animation = 'none';
            void UI.combo.offsetWidth;
            UI.combo.style.animation = '';
        } else {
            UI.combo.classList.add('hidden');
        }
    }

    // Round / transition banners ("ROUND 1", "NEXT OPPONENT", "READY!").
    showBanner(text, cls = 'round') {
        const el = UI.roundBanner;
        if (!el) return;
        el.className = 'round-banner hidden';
        void el.offsetWidth;                      // restart the CSS animation
        el.textContent = text;
        el.classList.remove('hidden');
        el.classList.add('show', cls);
        clearTimeout(this._bannerTimer);
        this._bannerTimer = setTimeout(() => {
            el.classList.remove('show', cls);
            el.classList.add('hidden');
        }, 1250);
    }

    addLog(message, cls = '') {
        const li = document.createElement('li');
        if (cls) li.className = cls;
        li.innerHTML = message;
        UI.log.list.appendChild(li);
        while (UI.log.list.children.length > this._logCap) {
            UI.log.list.removeChild(UI.log.list.firstChild);
        }
        UI.log.list.parentElement.scrollTop = UI.log.list.parentElement.scrollHeight;
    }

    clearLog() { UI.log.list.innerHTML = ''; }

    showImpact(defenderEl, text, extraClass = '') {
        const layer = defenderEl.parentElement;
        const layerRect = layer.getBoundingClientRect();
        const rect = defenderEl.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = `impact-text ${extraClass}`;
        el.textContent = text;
        el.style.left = `${rect.left - layerRect.left + rect.width / 2}px`;
        el.style.top = `${rect.top - layerRect.top + rect.height * 0.15}px`;
        layer.appendChild(el);
        setTimeout(() => el.remove(), 850);
    }

    showDamageNumber(targetEl, text, cls = '') {
        const layerRect = UI.damageLayer.getBoundingClientRect();
        const rect = targetEl.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = `damage-number ${cls}`;
        el.textContent = text;
        el.style.left = `${rect.left - layerRect.left + rect.width * rand(0.35, 0.65)}px`;
        el.style.top = `${rect.top - layerRect.top + rect.height * 0.2}px`;
        UI.damageLayer.appendChild(el);
        setTimeout(() => el.remove(), 950);
    }

    showStartScreen() {
        UI.overlay.container.classList.remove('hidden');
        UI.overlay.message.textContent = 'BATTLE ARENA';
        UI.overlay.message.className = 'start';
        UI.overlay.sub.classList.remove('hidden');
        UI.overlay.stats.classList.add('hidden');
        UI.overlay.restartBtn.textContent = 'ENTER ARENA';
        UI.controls.panel.classList.add('overlay-open');
        // No actions available until the fight actually starts.
        for (const btn of Object.values(this.buttons)) {
            if (btn && btn.tagName !== 'DIV') btn.disabled = true;
        }
    }

    showResult({ win, stats }) {
        UI.overlay.container.classList.remove('hidden');
        UI.overlay.message.textContent = win ? 'VICTORY!' : 'DEFEATED';
        UI.overlay.message.className = win ? 'victory' : '';
        UI.overlay.sub.classList.add('hidden');
        if (win) {
            UI.overlay.stats.classList.remove('hidden');
            UI.stats.rounds.textContent = stats.rounds;
            UI.stats.damage.textContent = stats.damage;
            UI.stats.crits.textContent = stats.crits;
            UI.stats.enemies.textContent = stats.enemies;
            UI.overlay.restartBtn.textContent = 'PLAY AGAIN';
        } else {
            UI.overlay.stats.classList.add('hidden');
            UI.overlay.restartBtn.textContent = 'RETRY';
        }
        UI.controls.panel.classList.add('overlay-open');
    }

    hideOverlay() {
        UI.overlay.container.classList.add('hidden');
        UI.controls.panel.classList.remove('overlay-open');
    }
}

/* ========================= ANIMATION SYSTEM ============================= */
// Central animation playback: named states, single-flight lock, and every
// sequence is guaranteed to return to idle in its finally block.
class AnimationSystem {
    constructor(sprites, fx, ui) {
        this.sprites = sprites;   // { hero, monster }
        this.fx = fx;
        this.ui = ui;
        this.playing = false;
        this._hitStopToken = 0;
    }

    contactPoint(sprite, point) {
        const fxRect = UI.fxCanvas.getBoundingClientRect();
        const rect = sprite.canvas.getBoundingClientRect();
        const sx = rect.width / sprite.canvas.width;
        const sy = rect.height / sprite.canvas.height;
        const localX = sprite.flipped ? sprite.canvas.width - point.x : point.x;
        return {
            x: rect.left - fxRect.left + localX * sx,
            y: rect.top - fxRect.top + point.y * sy
        };
    }

    // Generic strike: wind-up -> arm swing + frame swap -> IMPACT (damage is
    // applied at the visual contact moment) -> hit-stop on heavy/crit -> hold
    // -> recover -> settle. Per-move profiles make each attack look distinct.
    async playStrike(sprite, profileKey, defenderEl, isHero, result) {
        const p = ANIM_PROFILES[profileKey] || ANIM_PROFILES.punch;
        if (this.playing) return;
        this.playing = true;

        const baseX = p.lunge + (p.anchor || 0);
        const defSprite = isHero ? this.sprites.monster : this.sprites.hero;
        const hitStopMs = (p.heavy || (result && result.isCritical)) ? (p.heavy ? 80 : 70) : 0;
        let hitClasses = [];
        sprite.canvas.classList.add(p.cls, 'is-active');
        if (defSprite) defSprite.canvas.classList.add('is-active');
        if (p.glow) sprite.canvas.style.filter += ' drop-shadow(0 0 18px rgba(255,210,60,0.95))';

        try {
            // 1) WIND-UP: coil back / chamber the strike (arm loads, hips sink)
            const armWind = p.armWind || 0;
            await tween(p.windupMs, t => {
                sprite.setRigPart('arm', { deg: lerp(0, armWind, t) });
                sprite.setPose(
                    lerp(0, p.windupX, t),
                    p.dipFirst ? lerp(0, p.dip * 0.5, t) : 0,
                    lerp(1, p.squashX || 1, t),
                    lerp(1, p.squashY || 1, t)
                );
            }, Ease.outQuad);

            // 2) STRIKE: swap frame, swing the arm (or sweep the kick) toward
            //    the opponent; damage lands at the visual impact moment.
            sprite.setFrame(p.frame);
            const impactT = 0.62;                     // when the hit connects
            let applied = false;
            await tween(p.strikeMs, t => {
                if (!applied && result.apply && t >= impactT) { applied = true; result.apply(); }
                const e = Ease.outCubic(t);
                if (p.armStrike !== undefined) {
                    sprite.setRigPart('arm', { deg: lerp(armWind, p.armStrike, e), x: lerp(0, 2, e) });
                }
                if (p.trail && t > 0.35) this._trail(sprite, p, t);
                sprite.setPose(
                    lerp(p.windupX, baseX, e),
                    lerp(p.dipFirst ? p.dip * 0.5 : 0, p.rise !== undefined && p.rise !== 0 ? p.rise : (p.lift ? -p.lift : (p.dip || 0)), e),
                    lerp(p.squashX || 1, 1, e),
                    lerp(p.squashY || 1, 1, e),
                    lerp(0, p.rot || 0, e)
                );
            });
            if (!applied && result.apply) { applied = true; result.apply(); }

            // 3) IMPACT: FX, shake, defender reaction and damage numbers fire
            //    (whiff / dodge / block branches also live in _impact).
            hitClasses = this._impact(sprite, defenderEl, isHero, result, p, hitStopMs);

            // 4) HIT-STOP: freeze both fighters briefly on heavy/ultimate hits.
            if (hitStopMs > 0) await this._hitStop(hitStopMs);

            // 5) HOLD: brief follow-through so the hit reads clearly
            const holdY = p.rise !== undefined && p.rise !== 0 ? p.rise : -(p.lift || 0);
            await tween(p.holdMs, t => {
                sprite.setRigPart('arm', { deg: lerp(p.armStrike || 0, 0, t), x: lerp(2, 0, t) });
                sprite.setPose(baseX + 5 * t, holdY + 4 * t, 1, 1, (p.rot || 0) * (1 - 0.3 * t));
            }, Ease.outQuad);

            // 6) RECOVER: back to idle frame, retract the limb
            sprite.setFrame('idle');
            await tween(p.recoverMs, t => {
                const e = Ease.inOutQuad(t);
                sprite.setRigPart('arm', { deg: -lerp(0, armWind * 0.8, e) });
                sprite.setPose(
                    lerp(baseX + 5 - (p.anchor || 0), 0, e),
                    lerp(holdY + 4, 0, e),
                    1, 1,
                    lerp((p.rot || 0) * 0.7, 0, e)
                );
            }, Ease.inOutQuad);

            // 7) SETTLE: weight shifts back into the fighting stance
            await tween(p.settleMs, t => {
                const s = Math.sin(t * Math.PI);
                sprite.setPose(-3 * s, 0, 1 + 0.02 * s, 1 - 0.03 * s);
            }, Ease.outQuad);
        } finally {
            sprite.setFrame('idle');
            this.releaseVisuals(sprite, defSprite, p, hitClasses, defenderEl);
            this.playing = false;
        }
    }

    // Clean up every visual the strike applied (pose, classes, glow, filters).
    releaseVisuals(sprite, defSprite, p, hitClasses, defenderEl) {
        sprite.resetPose();
        sprite.resetRig();
        sprite.canvas.classList.remove(p.cls, 'is-active');
        if (defSprite) {
            defSprite.canvas.classList.remove('flash-red');
            // is-active on the defender is owned by its own reaction sequence
        }
        if (p.glow) {
            sprite.canvas.style.filter = sprite.canvas.style.filter
                .replace(' drop-shadow(0 0 18px rgba(255,210,60,0.95))', '');
        }
        if (defenderEl) defenderEl.classList.remove(...(hitClasses || []));
    }

    // Defender reaction + floating text + particles at the moment of contact.
    // hitStopMs delays the reaction so both fighters freeze together on heavy
    // blows, then the knockback sweep plays.
    _impact(sprite, defenderEl, isHero, result, profile, hitStopMs = 0) {
        const isKick = profile.frame === 'kick';
        const contact = this.contactPoint(sprite, profile.point);
        const dir = isHero ? 1 : -1;
        const defenderSide = isHero ? 'monster' : 'hero';
        const defSprite = isHero ? this.sprites.monster : this.sprites.hero;
        const move = result.moveKey ? MOVES[result.moveKey] : null;

        // --- whiff ---
        if (result.missed) {
            this.fx.burst(contact.x, contact.y, { dir, sparks: 0, dust: 5 });
            this.ui.showImpact(defenderEl, 'MISS!', 'miss');
            this.ui.showDamageNumber(defenderEl, 'MISS', 'dodged-num');
            this._defendReaction(defSprite, 'whiff', false, 0);
            return [];
        }

        // --- defender avoided it entirely ---
        if (result.dodged || result.evaded) {
            const word = result.dodged ? 'DODGED!' : 'EVADED!';
            const cls = result.dodged ? `dodge-${defenderSide}` : `crouch-${defenderSide}`;
            this.ui.showImpact(defenderEl, word, result.dodged ? 'dodged' : 'miss');
            this.ui.showDamageNumber(defenderEl, word, 'dodged-num');
            defenderEl.classList.add(cls);
            SoundFX.dodge();
            this._defendReaction(defSprite, result.dodged ? 'dodge' : 'crouch', false, 0);
            this._scheduleCleanup(defenderEl, cls, 700);
            return [];
        }

        // --- blocked (reduced damage) ---
        if (result.blocked) {
            triggerScreenShake(false);
            this.fx.burst(contact.x, contact.y, { dir, sparks: 10, dust: 4, hue: 200 });
            this.ui.showImpact(defenderEl, 'BLOCKED!', 'blocked');
            this.ui.showDamageNumber(defenderEl, `${result.damage}`, 'blocked-num');
            defenderEl.classList.add(`brace-${defenderSide}`);
            SoundFX.block();
            this._defendReaction(defSprite, 'block', false, 0);
            this._scheduleCleanup(defenderEl, `brace-${defenderSide}`, 450);
            return [];
        }

        // --- clean hit ---
        const heavy = profile.heavy || result.isCritical;
        // Crits and the ultimate (special) both earn the heavy shake.
        triggerScreenShake(result.isCritical || !!profile.glow);
        this.fx.burst(contact.x, contact.y, {
            dir,
            sparks: result.isCritical ? 48 : (heavy ? 34 : 20),
            dust: result.isCritical ? 14 : 8,
            crit: result.isCritical,
            hue: profile.glow ? 45 : 28
        });

        const sfxList = move ? move.sfx : ['POW!'];
        const word = pick(sfxList);
        this.ui.showImpact(defenderEl, word, `${isKick ? 'kick' : 'punch'}${result.isCritical ? ' crit' : ''}`);
        this.ui.showDamageNumber(defenderEl, `${result.damage}${result.isCritical ? '!' : ''}`, result.isCritical ? 'crit' : '');

        if (profile.glow) SoundFX.special();
        else if (result.isCritical) SoundFX.crit();
        else SoundFX[profile.frame === 'kick' ? 'kick' : (result.raw >= 20 ? 'heavy' : 'punch')]();
        if (result.isCritical) this.ui.showDamageNumber(defenderEl, 'CRITICAL!', 'crit');

        // Tiered body reaction: light / low / heavy / critical.
        const tier = result.isCritical ? 'crit' : (heavy ? 'heavy' : (profile.low ? 'low' : 'light'));
        const classes = this._defendReaction(defSprite, tier, result.isCritical, hitStopMs);
        // The ultimate (special) gets its own big-finish callout; otherwise the
        // crit path keeps its HEAVY HIT label (never more than 2 labels + the
        // damage number on screen).
        if (profile.glow) this.ui.showDamageNumber(defenderEl, 'ULTIMATE!', 'ult-num');
        else if (result.isCritical) this.ui.showDamageNumber(defenderEl, 'HEAVY HIT', 'heavy-num');
        return classes;
    }

    // JS-driven defender reaction: head snap + tiered recoil/knockback sweep.
    // Fire-and-forget with a per-sprite token so new actions always win.
    _defendReaction(defSprite, tier, isCrit = false, delayMs = 0) {
        if (!defSprite) return [];
        const REACT = REACTIONS[tier] || REACTIONS.light;
        const classes = [];
        if (isCrit) {
            classes.push('flash-red');
            defSprite.canvas.classList.add('flash-red');
            if (defSprite.rig.head) defSprite.rig.head.classList.add('head-flash');
        }
        defSprite.canvas.classList.add('is-active');
        const token = ++defSprite.reactToken;
        (async () => {
            try {
                if (delayMs > 0) await sleep(delayMs);
                if (token !== defSprite.reactToken) return;
                if (REACT.headDeg) defSprite.setRigPart('head', { deg: REACT.headDeg });
                for (const step of REACT.seq || []) {
                    if (token !== defSprite.reactToken) return;
                    await tween(step.ms, t => {
                        if (token !== defSprite.reactToken) return;
                        defSprite.setPose(
                            step.x(t),
                            step.y(t),
                            step.sx ? step.sx(t) : 1,
                            step.sy ? step.sy(t) : 1,
                            step.r(t)
                        );
                    }, step.ease || Ease.outQuad);
                }
                if (token !== defSprite.reactToken) return;
                await tween(REACT.recoverMs, t => {
                    if (token !== defSprite.reactToken) return;
                    const e = Ease.outQuad(t);
                    defSprite.setPose(lerp(0, REACT.restX, e), 0, 1, 1, lerp(0, REACT.restR, e));
                }, Ease.outQuad);
            } catch (e) { /* a reaction must never break the game */ }
            finally {
                if (token === defSprite.reactToken) {
                    defSprite.canvas.classList.remove('flash-red', 'is-active');
                    if (defSprite.rig.head) defSprite.rig.head.classList.remove('head-flash');
                    defSprite.resetPose();
                    defSprite.resetRig();
                }
            }
        })();
        return classes;
    }

    _scheduleCleanup(el, cls, ms) {
        setTimeout(() => el.classList.remove(cls), ms);
    }

    _trail(sprite, profile, t) {
        const contact = this.contactPoint(sprite, profile.point);
        const dir = sprite.flipped ? 1 : -1;
        this.fx.slash(
            contact.x - 46 * dir, contact.y + 12,
            contact.x, contact.y,
            { cp: { x: contact.x - 18 * dir, y: contact.y - 34 }, hue: sprite.flipped ? 4 : 45, width: 7 }
        );
    }

    _landingDust(sprite) {
        const rect = sprite.canvas.getBoundingClientRect();
        const fxRect = UI.fxCanvas.getBoundingClientRect();
        this.fx.burst(
            rect.left - fxRect.left + rect.width * 0.5,
            rect.top - fxRect.top + rect.height * 0.92,
            { dir: sprite.flipped ? -1 : 1, sparks: 4, dust: 14 }
        );
    }

    // Freeze both fighters: pause CSS animations on the container + a short
    // refractory sleep that the defender reaction awaits before its sweep.
    async _hitStop(ms) {
        const c = UI.gameContainer;
        c.classList.add('hit-stop');
        const token = ++this._hitStopToken;
        await sleep(ms);
        if (token === this._hitStopToken) c.classList.remove('hit-stop');
    }

    _endHitStop() {
        this._hitStopToken++;
        UI.gameContainer.classList.remove('hit-stop');
    }

    // One-shot enrage surge on the monster (chest-thump + shake), then leave
    // the ongoing CSS pulse to handle the glow.
    enrageSurge(sprite) {
        if (!sprite) return;
        const token = ++sprite.reactToken;
        sprite.canvas.classList.add('is-active');
        (async () => {
            try {
                await tween(240, t => {
                    if (token !== sprite.reactToken) return;
                    const s = Math.sin(t * Math.PI * 4);
                    sprite.setPose(0, 0, 1 + 0.05 * s, 1 - 0.03 * s, 3 * s);
                }, Ease.outQuad);
                if (token !== sprite.reactToken) return;
                sprite.resetPose();
                sprite.resetRig();
            } catch (e) { /* enrage surge is cosmetic */ }
            finally {
                if (token === sprite.reactToken) sprite.canvas.classList.remove('is-active');
            }
        })();
    }

    // Drop a held guard / stance pose back to rest.
    releaseGuard(sprite) {
        if (!sprite) return;
        const side = sprite.flipped ? 'monster' : 'hero';
        sprite.canvas.classList.remove('blocking', 'healing', 'is-active',
            `brace-${side}`, `dodge-${side}`, `crouch-${side}`);
        sprite.resetPose();
        sprite.resetRig();
    }

    // Defensive / utility poses (block, dodge, crouch, heal, ko, entrance).
    // block/dodge/crouch hold their guard pose (released by the controller
    // after the exchange); heal is transient and cleans itself up.
    async playStance(sprite, anim, isHero) {
        const side = isHero ? 'hero' : 'monster';
        const cls = { block: `brace-${side}`, dodge: `dodge-${side}`, crouch: `crouch-${side}`, heal: 'healing' }[anim];
        if (!cls) return;
        sprite.canvas.classList.add('is-active');

        if (anim === 'block') {
            // arms rise into a defensive guard — held until released
            sprite.canvas.classList.add(cls, 'blocking');
            await tween(160, t => {
                const e = Ease.outQuad(t);
                sprite.setRigPart('arm', { deg: lerp(0, 20, e), y: -lerp(0, 6, e) });
                sprite.setPose(0, 0, 1, 0.99, lerp(0, -2, e));
            }, Ease.outQuad);
            await sleep(340);
            return;
        }
        if (anim === 'dodge') {
            // directional slip — body leans, feet stay planted, head tucks
            sprite.canvas.classList.add(cls);
            await tween(180, t => {
                const e = Ease.outQuad(t);
                sprite.setRigPart('head', { deg: 10, x: -8 });
                sprite.setPose(lerp(0, -22, e), 0, 1, 1, lerp(0, 6, e));
            }, Ease.outQuad);
            await sleep(140);
            return;
        }
        if (anim === 'crouch') {
            // lower the whole body (no full-scale), head drops too
            sprite.canvas.classList.add(cls);
            await tween(200, t => {
                const e = Ease.outQuad(t);
                sprite.setRigPart('head', { y: 10 });
                sprite.setPose(0, lerp(0, 14, e), 1, lerp(1, 0.9, e));
            }, Ease.outQuad);
            await sleep(300);
            return;
        }
        // heal: raise the arm, glow, then settle back
        sprite.canvas.classList.add(cls);
        await tween(220, t => {
            const e = Ease.outQuad(t);
            sprite.setRigPart('arm', { deg: lerp(0, 12, e), y: -lerp(0, 10, e) });
            sprite.setPose(0, lerp(0, -4, e), 1, 1);
        }, Ease.outQuad);
        await sleep(320);
        await tween(200, t => {
            const e = Ease.outQuad(t);
            sprite.setRigPart('arm', { deg: lerp(12, 0, e), y: lerp(-10, 0, e) });
            sprite.setPose(0, lerp(-4, 0, e), 1, 1);
        }, Ease.outQuad);
        sprite.canvas.classList.remove('healing', 'is-active');
    }

    // Staged KO: stagger -> crumple -> landing dust. The fallen pose is kept
    // (the next spawn/re-start re-poses the fighter).
    async playKO(sprite, isHero) {
        SoundFX.ko();
        sprite.canvas.classList.add('is-active');
        if (sprite.shadow) sprite.shadow.classList.add('floated');
        try {
            // 1) STAGGER: snap back, reeling
            await tween(140, t => {
                const e = Ease.outCubic(t);
                sprite.setRigPart('head', { deg: -18 });
                sprite.setPose(lerp(0, -26, e), lerp(0, -8, e), 1, 1, lerp(0, -14, e));
            }, Ease.outCubic);
            // 2) CRUMPLE: knees give out, body folds over
            await tween(430, t => {
                const e = Ease.inCubic(t);
                sprite.setRigPart('head', { deg: -34 });
                sprite.setPose(lerp(-26, 0, e), lerp(-8, 26, e), 1, 1 - 0.35 * e, lerp(-14, -72, e));
            }, Ease.inCubic);
            // 3) DUST + rest
            this._landingDust(sprite);
            await sleep(140);
        } finally {
            sprite.canvas.classList.add(isHero ? 'ko-hero' : 'ko-monster');
            sprite.canvas.classList.remove('is-active');
            if (sprite.shadow) sprite.shadow.classList.remove('floated');
            // keep the fallen pose — only the rig settles back to neutral
            sprite.resetRig();
        }
    }

    async playEntrance(sprite, fromX) {
        const guard = sprite.reactToken;
        sprite.canvas.classList.add('is-active');
        try {
            // approach from off-screen, bounce on the landing, kick up dust
            await tween(520, t => {
                const e = Ease.outCubic(t);
                sprite.setPose(lerp(fromX, 0, e), 0, 1, 1);
            }, Ease.outCubic);
            await tween(140, t => sprite.setPose(0, -12 * (1 - Ease.outQuart(t)), 1, 1), Ease.outQuart);
            await tween(120, t => {
                const e = Ease.outQuad(t);
                sprite.setPose(0, -12, 1 + 0.06 * (1 - e), 1 - 0.08 * (1 - e));
            }, Ease.outQuad);
            this._landingDust(sprite);
            await sleep(60);
        } finally {
            if (guard === sprite.reactToken) {
                sprite.resetPose();
                sprite.resetRig();
            }
            sprite.canvas.classList.remove('is-active');
        }
    }
}

/* ========================== GAME CONTROLLER ============================= */
class GameController {
    constructor() {
        this.state = GameState.START;
        this.ui = new UIController();
        this.sprites = {
            hero: new FighterSprite(UI.hero.canvas, 'hero'),
            monster: new FighterSprite(UI.monster.canvas, 'monster')
        };
        this.fx = new ParticleFX(UI.fxCanvas);
        this.anim = new AnimationSystem(this.sprites, this.fx, this.ui);
        this.hero = null;
        this.monsters = [];
        this.currentMonsterIndex = 0;
        this.runToken = 0;         // invalidates stale async flows on restart
        this.stats = { rounds: 0, damage: 0, crits: 0, enemies: 0 };
        // Load BOTH fighters' keyed frames once up front (hero + monster).
        this._spritesReady = Promise.all([
            this.sprites.hero.load(FIGHTER_FRAMES),
            this.sprites.monster.load(FIGHTER_FRAMES)
        ]).catch(err => console.error('Sprite load failed:', err));
        this.bindEvents();
        this.ui.showStartScreen();
    }

    get currentMonster() { return this.monsters[this.currentMonsterIndex] || null; }

    bindEvents() {
        // Wire every button to its move (data-move attributes in the HTML).
        for (const [key, btn] of Object.entries(UI.controls)) {
            if (!btn || !btn.dataset.move) continue;
            const moveKey = btn.dataset.move;
            btn.addEventListener('click', () => {
                SoundFX.click();
                this.handleAction(moveKey);
            });
        }
        UI.overlay.restartBtn.addEventListener('click', () => {
            SoundFX.click();
            this.startGame();
        });

        // Keyboard shortcuts (numbers for strikes, letters for specials).
        const KEY_MAP = {
            '1': 'jab', '2': 'punch', '3': 'heavyPunch', '4': 'uppercut',
            '5': 'frontKick', '6': 'lowKick', '7': 'roundhouse', '8': 'heavyKick',
            'q': 'block', 'e': 'dodge', 'c': 'crouch', 'h': 'heal', 'r': 'special',
            // legacy keys from the original build
            'a': 'punch', 's': 'roundhouse', 'd': 'heal'
        };
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            if (!UI.overlay.container.classList.contains('hidden')) return;
            if (e.target && /input|textarea/i.test(e.target.tagName)) return;
            const key = e.key.toLowerCase();
            const moveKey = KEY_MAP[key];
            if (moveKey) {
                e.preventDefault();
                this.handleAction(moveKey);
            }
        });
    }

    async startGame() {
        // Only valid from idle/end states — never restart mid-fight.
        const okStates = [GameState.START, GameState.GAME_OVER, GameState.VICTORY, GameState.DEFEAT];
        if (!okStates.includes(this.state)) return;
        const token = ++this.runToken;
        try {
            await this._runStart(token);
        } catch (err) {
            console.error('startGame failed:', err);
            // Never leave the game stuck in ROUND_TRANSITION — offer a retry.
            if (token === this.runToken) {
                this.state = GameState.START;
                this.ui.showStartScreen();
            }
        }
    }

    async _runStart(token) {
        // Fresh hero + full gauntlet of monsters.
        this.hero = new Hero('Ryko', 220, 20, 60);
        this.monsters = [
            new Monster({ name: 'Goblin Brawler', hp: 130, atk: 14, level: 1, hue: 90,
                portrait: 'assets/goblin.jpg', style: 'aggressive',
                moveSet: ['jab', 'punch', 'lowKick', 'frontKick', 'block'] }),
            new Monster({ name: 'Orc Brute', hp: 190, atk: 21, level: 2, hue: 0,
                portrait: 'assets/orc.jpg', style: 'heavy',
                moveSet: ['punch', 'heavyPunch', 'lowKick', 'frontKick', 'roundhouse', 'block', 'dodge'] }),
            new Monster({ name: 'Draconic Overlord', hp: 280, atk: 27, level: 3, hue: 190,
                portrait: 'assets/dragon.jpg', style: 'boss',
                moveSet: ['jab', 'punch', 'heavyPunch', 'uppercut', 'frontKick', 'roundhouse', 'heavyKick', 'block', 'dodge'] })
        ];
        this.currentMonsterIndex = 0;
        this.stats = { rounds: 0, damage: 0, crits: 0, enemies: 0 };

        UI.hero.name.textContent = this.hero.name;
        this.ui.hideOverlay();
        this.ui.clearLog();
        this.ui.setTimer('FIGHT!');
        this.ui.setTurn('YOUR TURN', false, true);
        this.ui.addLog('FIGHT! Defeat all three enemies to win.', 'system-log');
        this.ui.showCombo(0);
        UI.gameContainer.classList.remove('hit-stop', 'enrage-boom', 'player-low');
        // The hero must start every run pristine: a KO fade-out, hurt wobble,
        // guard pose or half-finished attack frame left over from the previous
        // run (DEFEAT → RETRY kept ko-hero and left the canvas dimmed) must
        // never leak into this one.
        const hSprite = this.sprites.hero;
        this.anim.releaseGuard(hSprite);
        UI.hero.canvas.classList.remove('ko-hero', 'hurt-state', 'low-hp',
            'flash-red', 'is-punching', 'is-kicking');
        if (hSprite.rig.head) hSprite.rig.head.classList.remove('hidden', 'head-enraged', 'head-flash');
        if (hSprite.shadow) hSprite.shadow.classList.remove('floated');

        this.state = GameState.ROUND_TRANSITION;
        await this._spritesReady;
        if (token !== this.runToken) return;

        this.anim._endHitStop();
        this.ui.showBanner('ROUND 1', 'round');
        await sleep(450);
        if (token !== this.runToken) return;

        await this.anim.playEntrance(this.sprites.hero, -420);
        if (token !== this.runToken) return;

        this.spawnMonster(true);
        this.ui.showBanner('READY!', 'ready');
        await sleep(400);
        if (token !== this.runToken) return;

        this.state = GameState.PLAYER_TURN;
        this.ui.updateHUD(this.hero, this.currentMonster);
        this.ui.updateButtons(this.state, this.hero);
    }

    spawnMonster(withEntrance = false) {
        const monster = this.currentMonster;
        if (!monster) return;
        const mSprite = this.sprites.monster;
        // Clear leftover state classes/poses from the previous life.
        UI.monster.canvas.classList.remove('ko-monster', 'enraged', 'hurt-state', 'low-hp', 'blocking', 'healing', 'is-active', 'flash-red');
        if (mSprite.rig.head) mSprite.rig.head.classList.remove('hidden', 'head-enraged');
        this.anim.releaseGuard(mSprite);
        this.ui.setMonsterInfo(monster);
        applyFighterFilter(UI.monster.canvas, monster.hue, '', [
            mSprite.rig.head, mSprite.rig.arm
        ]);
        this.ui.setTimer(`ROUND ${this.currentMonsterIndex + 1}`);
        this.ui.addLog(`Round ${this.currentMonsterIndex + 1}: <b>${monster.name}</b> enters the arena!`, 'system-log');
        if (withEntrance) {
            // Fire-and-forget (never awaited): guard against rejection.
            Promise.resolve(this.anim.playEntrance(this.sprites.monster, -500)).catch(() => {});
        }
        this.ui.updateHUD(this.hero, monster);
    }

    /* -------------------- central action dispatcher ---------------------- */
    async handleAction(moveKey) {
        if (this.state !== GameState.PLAYER_TURN) return;   // state guard
        const hero = this.hero;
        const monster = this.currentMonster;
        if (!hero || !hero.isAlive() || !monster || !monster.isAlive()) return;

        const move = MOVES[moveKey];
        if (!move) return;
        if (!hero.canSpend(move)) {
            this.ui.addLog(`Not enough ${move.manaCost ? 'mana' : 'stamina'} for ${move.label}!`, 'enemy-log');
            return;
        }

        const token = this.runToken;
        this.state = GameState.ANIMATING;
        this.ui.updateButtons(this.state, hero);

        // Safety net: an unexpected error must never soft-lock the game.
        try {
            if (move.kind === 'defend') {
                await this._playerDefend(hero, moveKey, token);
            } else if (move.kind === 'utility') {
                await this._playerHeal(hero, moveKey, token);
            } else {
                await this._playerAttack(hero, monster, moveKey, token);
            }
        } catch (err) {
            console.error('Action failed:', err);
            if (token === this.runToken && this.state === GameState.ANIMATING) {
                this.state = GameState.PLAYER_TURN;
                this.ui.setTurn('YOUR TURN', false, true);
                this.ui.updateHUD(hero, this.currentMonster);
                this.ui.updateButtons(this.state, hero);
            }
        }
    }

    async _playerDefend(hero, moveKey, token) {
        const move = MOVES[moveKey];
        hero.spend(move);
        hero.stance = move.stance;
        hero.resetCombo();
        this.ui.showCombo(0);
        this.ui.addLog(`You take a <b>${move.label}</b> stance.`, 'player-log');
        await this.anim.playStance(this.sprites.hero, move.anim, true);
        if (token !== this.runToken) return;
        this.ui.updateHUD(hero, this.currentMonster);
        await this._enemyTurn(token);
    }

    async _playerHeal(hero, moveKey, token) {
        const res = hero.heal();
        if (!res.success) {
            this.ui.addLog(res.reason, 'enemy-log');
            this.state = GameState.PLAYER_TURN;
            this.ui.updateButtons(this.state, hero);
            return;
        }
        this.ui.addLog(`You restore <b>${res.healed} HP</b>.`, 'heal-log');
        await this.anim.playStance(this.sprites.hero, 'heal', true);
        this.ui.showImpact(UI.hero.canvas, `+${res.healed}`, 'heal');
        this.ui.showDamageNumber(UI.hero.canvas, `+${res.healed}`, 'heal-num');
        SoundFX.heal();
        if (token !== this.runToken) return;
        this.ui.updateHUD(hero, this.currentMonster);
        await this._enemyTurn(token);
    }

    async _playerAttack(hero, monster, moveKey, token) {
        const move = MOVES[moveKey];
        hero.stance = 'idle';                       // attacking breaks guard
        this.state = GameState.ANIMATING;

        // Prepare resolves costs + rolls synchronously; the animation system
        // calls apply() at the visual impact moment.
        const res = hero.prepareAttack(monster, moveKey);
        if (res.failed) {
            this.ui.addLog(`Not enough ${res.reason}!`, 'enemy-log');
            this.state = GameState.PLAYER_TURN;
            this.ui.updateButtons(this.state, hero);
            return;
        }
        if (res.invalid) return;

        this.stats.rounds++;
        await this.anim.playStrike(this.sprites.hero, move.anim, UI.monster.canvas, true, res);
        if (token !== this.runToken) return;

        this._logAttack(hero.name, res, true);
        if (!res.missed && !res.dodged && !res.evaded) {
            this.stats.damage += res.damage;
            if (res.isCritical) this.stats.crits++;
            hero.registerHit();
            this.ui.showCombo(hero.combo);
        } else {
            hero.resetCombo();
            this.ui.showCombo(0);
        }

        // Visual states for the monster after taking damage.
        if (monster.isAlive()) {
            if (monster.maybeEnrage()) this._triggerEnrage(monster);
            UI.monster.canvas.classList.toggle('hurt-state', monster.healthPercent <= 30);
        }

        this.ui.updateHUD(hero, monster);
        this.ui.updateButtons(this.state, hero);

        if (!monster.isAlive()) {
            await this._monsterDefeated(token);
        } else {
            await sleep(350);
            if (token !== this.runToken) return;
            await this._enemyTurn(token);
        }
    }

    _logAttack(name, res, isHero) {
        const move = MOVES[res.moveKey];
        if (!move) return;
        if (res.missed) {
            this.ui.addLog(isHero ? `Your <b>${move.label}</b> missed!` : `${name}'s <b>${move.label}</b> missed!`, isHero ? 'player-log' : 'enemy-log');
            return;
        }
        if (res.dodged) {
            this.ui.addLog(isHero ? `${name} dodges the attack!` : `You dodged <b>${name}</b>'s attack!`, 'system-log');
            return;
        }
        if (res.evaded) {
            this.ui.addLog(isHero ? `${name} ducks under the strike!` : `You duck under the strike!`, 'system-log');
            return;
        }
        const crit = res.isCritical ? ' <b>CRITICAL!</b>' : '';
        const blocked = res.blocked ? ' (blocked)' : '';
        if (isHero) {
            this.ui.addLog(`You used <b>${move.label}</b> — ${res.damage} damage.${crit}${blocked}`, res.isCritical ? 'crit-log' : 'player-log');
        } else {
            this.ui.addLog(`${name} used <b>${move.label}</b> — ${res.damage} damage.${crit}${blocked}`, res.isCritical ? 'crit-log' : 'enemy-log');
        }
    }

    _triggerEnrage(monster) {
        const mSprite = this.sprites.monster;
        UI.monster.canvas.classList.add('enraged');
        const head = mSprite.rig.head;
        const arm = mSprite.rig.arm;
        if (head) head.classList.add('head-enraged');
        // Mirror the CSS enrage glow onto the overlay layers (their inline
        // filter would otherwise keep the plain hue look while the canvas
        // flashes blood-red via the !important .enraged rule).
        const enrageFilter = 'drop-shadow(10px 20px 10px rgba(0,0,0,0.8)) '
            + 'drop-shadow(0 0 14px rgba(255,40,40,0.95)) saturate(1.5)';
        if (head) head.style.filter = enrageFilter;
        if (arm) arm.style.filter = enrageFilter;
        UI.gameContainer.classList.add('enrage-boom');
        setTimeout(() => UI.gameContainer.classList.remove('enrage-boom'), 900);
        const rect = UI.fxCanvas.getBoundingClientRect();
        const mc = UI.monster.canvas.getBoundingClientRect();
        this.fx.burst(mc.left - rect.left + mc.width * 0.5, mc.top - rect.top + mc.height * 0.35,
            { sparks: 28, dust: 8, hue: 0 });
        this.anim.enrageSurge(mSprite);
        this.ui.addLog(`<b>${monster.name} is ENRAGED!</b> Attack power surged!`, 'enemy-log');
        this.ui.showImpact(UI.monster.canvas, 'ENRAGED!', 'crit');
        SoundFX.enrage();
    }

    /* ----------------------------- enemy turn --------------------------- */
    async _enemyTurn(token) {
        const monster = this.currentMonster;
        const hero = this.hero;
        if (!monster || !monster.isAlive() || !hero.isAlive()) return;

        this.state = GameState.ENEMY_TURN;
        this.ui.setTurn('ENEMY TURN', true, true);
        this.ui.updateButtons(this.state, hero);
        await sleep(500);
        if (token !== this.runToken) return;

        if (monster.maybeEnrage()) this._triggerEnrage(monster);

        const action = EnemyAI.chooseAction(monster, hero);
        const token2 = token;

        if (action === 'recover') {
            monster.regenStamina(45);
            this.ui.addLog(`${monster.name} catches its breath. (+stamina)`, 'system-log');
            await sleep(550);
        } else if (MOVES[action] && MOVES[action].kind === 'defend') {
            monster.spend(MOVES[action]);
            monster.stance = MOVES[action].stance;
            this.ui.addLog(`${monster.name} takes a <b>${MOVES[action].label}</b> stance.`, 'enemy-log');
            await this.anim.playStance(this.sprites.monster, MOVES[action].anim, false);
        } else if (MOVES[action] && MOVES[action].kind === 'attack') {
            const res = monster.prepareAttack(hero, action);
            if (res.failed) {
                monster.regenStamina(30);
                this.ui.addLog(`${monster.name} is too winded to attack!`, 'system-log');
                await sleep(400);
            } else {
                this.state = GameState.ANIMATING;
                await this.anim.playStrike(this.sprites.monster, MOVES[action].anim, UI.hero.canvas, false, res);
                if (token2 !== this.runToken) return;
                monster.stance = 'idle';
                this._logAttack(monster.name, res, false);
                this.ui.updateHUD(hero, monster);
            }
        }

        if (token2 !== this.runToken) return;

        // Hero defensive stance was consumed by this attack exchange.
        hero.stance = 'idle';
        this.anim.releaseGuard(this.sprites.hero);

        if (!hero.isAlive()) {
            await sleep(400);
            if (token2 !== this.runToken) return;
            await this.anim.playKO(this.sprites.hero, true);
            if (token2 !== this.runToken) return;
            this._endGame(false);
            return;
        }

        // Regeneration between rounds.
        hero.regenStamina(18);
        hero.gainMana(6);
        monster.regenStamina(14);

        UI.hero.canvas.classList.toggle('hurt-state', hero.healthPercent <= 30);
        this.ui.updateHUD(hero, monster);
        this.state = GameState.PLAYER_TURN;
        this.ui.setTurn('YOUR TURN', false, true);
        this.ui.updateButtons(this.state, hero);
    }

    /* --------------------------- round / game flow ---------------------- */
    async _monsterDefeated(token) {
        this.state = GameState.ROUND_TRANSITION;
        this.ui.updateButtons(this.state, this.hero);
        this.ui.addLog(`<b>${this.currentMonster.name} is defeated!</b>`, 'system-log');
        this.ui.setTimer('K.O.');
        this.ui.setTurn('', false, false);
        this.hero.resetCombo();
        this.ui.showCombo(0);

        await this.anim.playKO(this.sprites.monster, false);
        if (token !== this.runToken) return;

        this.stats.enemies++;
        this.currentMonsterIndex++;

        if (this.currentMonsterIndex >= this.monsters.length) {
            await sleep(500);
            if (token !== this.runToken) return;
            this._endGame(true);
            return;
        }

        // Victory transition: hero levels up, then the next enemy enters.
        this._levelUpHero();
        this.ui.showBanner('NEXT OPPONENT', 'next');
        await sleep(700);
        if (token !== this.runToken) return;
        this.spawnMonster(true);
        this.ui.showBanner('READY!', 'ready');
        await sleep(450);
        if (token !== this.runToken) return;
        this.state = GameState.PLAYER_TURN;
        this.ui.setTurn('YOUR TURN', false, true);
        this.ui.updateButtons(this.state, this.hero);
    }

    _levelUpHero() {
        const hero = this.hero;
        hero.level += 1;
        hero.attackPower = Math.round(hero.baseAttackPower * (1 + 0.12 * (hero.level - 1)));
        hero.maxHealth += 25;
        hero.restoreHealth(60);            // partial recovery between rounds
        hero.currentStamina = hero.maxStamina;
        hero.gainMana(15);
        UI.hero.canvas.classList.remove('hurt-state', 'low-hp');
        this.ui.addLog(`<b>LEVEL UP!</b> You are now Lv. ${hero.level}. HP, attack and resources increased.`, 'system-log');
        SoundFX.heal();
    }

    _endGame(win) {
        this.state = win ? GameState.VICTORY : GameState.DEFEAT;
        this.ui.setTurn('', false, false);
        this.ui.setTimer(win ? 'WIN!' : 'K.O.');
        this.ui.updateButtons(this.state, this.hero);
        UI.hero.canvas.classList.remove('hurt-state', 'low-hp');
        UI.monster.canvas.classList.remove('hurt-state', 'low-hp', 'enraged');
        if (this.sprites.monster.rig.head) this.sprites.monster.rig.head.classList.remove('head-enraged');
        this.anim._endHitStop();
        if (win) {
            SoundFX.victory();
            this.ui.addLog('<b>VICTORY!</b> All enemies defeated.', 'system-log');
        } else {
            SoundFX.defeat();
            this.ui.addLog('<b>DEFEATED...</b> You were knocked out.', 'enemy-log');
        }
        this.state = GameState.GAME_OVER;
        this.ui.showResult({
            win,
            stats: {
                rounds: this.stats.rounds,
                damage: this.stats.damage,
                crits: this.stats.crits,
                enemies: this.stats.enemies
            }
        });
    }
}

/* ============================== SCREEN FX =============================== */
const triggerScreenShake = (heavy = false) => {
    const el = UI.gameContainer;
    el.classList.remove('screen-shake', 'heavy');
    void el.offsetWidth;
    el.classList.add('screen-shake');
    if (heavy) el.classList.add('heavy');
    el.addEventListener('animationend', () => el.classList.remove('screen-shake', 'heavy'), { once: true });
};

/* ============================== BOOTSTRAP =============================== */
window.addEventListener('DOMContentLoaded', () => {
    try {
        window.game = new GameController();   // exposed for debugging/testing
    } catch (err) {
        console.error('Game failed to start:', err);
        const log = document.getElementById('log-list');
        if (log) {
            const li = document.createElement('li');
            li.className = 'enemy-log';
            li.textContent = 'Failed to initialise the arena. Check the console.';
            log.appendChild(li);
        }
    }
});
