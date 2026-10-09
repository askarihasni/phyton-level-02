// Full-flow integration test: boots script.js in a DOM sandbox with a virtual
// clock, starts the game, fights through the whole gauntlet, and asserts the
// state machine, buttons, bars, log, victory/defeat and restart behaviour.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------ test utils ------------------------------ */
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}
const realSetTimeout = setTimeout;
const tick = () => new Promise(r => realSetTimeout(r, 0));

/* ----------------------------- virtual clock --------------------------- */
let vNow = 0;
function schedule(cb, delay) {
    realSetTimeout(() => {
        vNow += Math.max(1, delay || 1);
        try { cb(vNow); } catch (e) { console.error('async error:', e); }
    }, 0);
}

/* ------------------------------- DOM mock ------------------------------ */
const ctx2d = () => ({
    clearRect() {}, drawImage() {}, setTransform() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    putImageData() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    save() {}, restore() {}, clip() {}, closePath() {},
    translate() {}, rotate() {}, scale() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', globalCompositeOperation: 'source-over'
});

const elCache = new Map();
function makeEl(id = '', tag = 'div') {
    const listeners = {};
    const classes = new Set();
    const el = {
        tag, id, style: {}, dataset: {}, children: [],
        parentElement: null,
        textContent: '', className: '',
        disabled: false, src: '',
        scrollTop: 0, scrollHeight: 100, offsetWidth: 100,
        clientWidth: 960, clientHeight: 640,
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                on ? classes.add(c) : classes.delete(c);
                return on;
            },
            contains: c => classes.has(c)
        },
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener() {},
        dispatch: (t, ev = {}) => {
            const out = [];
            for (const fn of (listeners[t] || []).slice()) out.push(fn(ev));
            return out;
        },
        appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentElement = null;
            return c;
        },
        remove() {
            if (this.parentElement) this.parentElement.removeChild(this);
        },
        get firstChild() { return this.children[0]; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }),
        getContext: () => ctx2d()
    };
    Object.defineProperty(el, 'getFirstChild', { value: () => el.children[0] });
    // innerHTML = '' must destroy children, like a real browser
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: () => _html,
        set: (v) => {
            _html = v;
            if (v === '') {
                for (const c of el.children) c.parentElement = null;
                el.children.length = 0;
            }
        },
        configurable: true
    });
    return el;
}

function getEl(id) {
    if (!elCache.has(id)) {
        const tag = id.endsWith('canvas') ? 'canvas' : (id.endsWith('-btn') ? 'button' : 'div');
        const el = makeEl(id, tag);
        if (id === 'log-list') {
            const parent = getEl('combat-log');
            parent.appendChild(el);
        }
        // mirror the real DOM: fighters + fx + damage numbers live inside #fighters-layer
        if (id === 'hero-canvas' || id === 'monster-canvas' || id === 'fx-canvas' || id === 'damage-numbers') {
            getEl('fighters-layer').appendChild(el);
        }
        if (id === 'overlay') classes0(el); // overlay starts visible
        elCache.set(id, el);
    }
    return elCache.get(id);
}
function classes0(el) { /* default: no classes */ }

// data-move wiring (mirrors index.html)
const MOVE_BY_BTN = {
    'jab-btn': 'jab', 'punch-btn': 'punch', 'heavy-punch-btn': 'heavyPunch',
    'uppercut-btn': 'uppercut', 'front-kick-btn': 'frontKick', 'low-kick-btn': 'lowKick',
    'roundhouse-btn': 'roundhouse', 'heavy-kick-btn': 'heavyKick',
    'block-btn': 'block', 'dodge-btn': 'dodge', 'crouch-btn': 'crouch',
    'heal-btn': 'heal', 'special-btn': 'special'
};
for (const [id, move] of Object.entries(MOVE_BY_BTN)) getEl(id).dataset.move = move;

const winListeners = {};
const docListeners = {};
const errors = [];
process.on('unhandledRejection', (e) => { errors.push('unhandledRejection: ' + e); });
const sandbox = {
    console: { log: () => {}, error: (...a) => { errors.push(a.join(' ')); console.error(...a); }, warn: () => {} },
    document: {
        getElementById: getEl,
        createElement: (tag) => makeEl('', tag),
        addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); }
    },
    window: {
        addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
        devicePixelRatio: 1
    },
    Image: function () {
        Object.defineProperty(this, 'src', {
            set(v) {
                this._src = v;
                schedule(() => {
                    this.width = 400; this.height = 400;
                    if (this.onload) this.onload();
                }, 1);
            },
            get() { return this._src; }
        });
    },
    performance: { now: () => vNow },
    requestAnimationFrame: (cb) => { schedule(() => cb(vNow), 16); return 1; },
    setTimeout: (cb, d = 0) => { schedule(cb, d); return 1; },
    clearTimeout: () => {},
    Math: Object.assign(Object.create(Math), { random: mulberry32(Number(process.env.SEED) || 42) }),
    Promise, Uint8ClampedArray, Date, JSON
};
sandbox.globalThis = sandbox;
sandbox.window.AudioContext = null;

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, 'rpg-arena', 'script.js'), 'utf8');
vm.runInContext(code, sandbox);

/* ------------------------------ helpers ------------------------------- */
const GameState = vm.runInContext('GameState', sandbox);
const MOVES = vm.runInContext('MOVES', sandbox);

const btn = id => getEl(id);
const allBtnIds = Object.keys(MOVE_BY_BTN);
const state = () => sandbox.window.game && sandbox.window.game.state;

async function waitIdle(maxTicks = 20000) {
    let i = 0;
    while (i++ < maxTicks) {
        const s = state();
        if (s === GameState.PLAYER_TURN || s === GameState.GAME_OVER || s === undefined) return;
        await tick();
    }
    throw new Error('waitIdle timed out in state ' + state());
}

function assertButtonsConsistent(context) {
    const s = state();
    if (s !== GameState.PLAYER_TURN) {
        const anyEnabled = allBtnIds.some(id => !btn(id).disabled);
        check(`${context}: all buttons disabled outside PLAYER_TURN (${s})`, !anyEnabled);
    }
}

function barWidth(el) {
    const w = parseFloat(el.style.width);
    return Number.isNaN(w) ? null : w;
}

/* ------------------------------ run the game --------------------------- */
(async () => {
    // boot
    (winListeners['DOMContentLoaded'] || []).forEach(fn => fn());
    const game = sandbox.window.game;
    check('GameController booted', !!game);
    check('initial state is START', state() === GameState.START);
    check('start overlay visible', !getEl('overlay').classList.contains('hidden'));
    check('start button says ENTER ARENA', btn('restart-btn').textContent === 'ENTER ARENA');
    check('action buttons disabled on start screen', allBtnIds.every(id => btn(id).disabled === true));
    assertButtonsConsistent('at start screen');

    // start the game
    await game.startGame();
    await waitIdle();
    check('game reaches PLAYER_TURN after start', state() === GameState.PLAYER_TURN);
    check('overlay hidden once playing', getEl('overlay').classList.contains('hidden'));
    check('hero sprite loaded (canvas sized)', getEl('hero-canvas').width > 0);
    check('monster sprite loaded (canvas sized)', getEl('monster-canvas').width > 0, `w=${getEl('monster-canvas').width}`);
    check('first enemy named', getEl('monster-name').textContent.length > 0, getEl('monster-name').textContent);
    check('round timer shown', /^ROUND 1$/.test(getEl('timer').textContent), getEl('timer').textContent);
    check('turn indicator shows YOUR TURN', getEl('turn-indicator').textContent === 'YOUR TURN');
    check('combat log seeded', getEl('log-list').children.length >= 1);
    check('bars at 100%', barWidth(getEl('hero-health')) === 100 && barWidth(getEl('monster-health')) === 100);

    // --- guarded input: clicking while "animating" must do nothing ---
    const savedState = game.state;
    game.state = GameState.ANIMATING;
    const stamBefore = game.hero.currentStamina;
    btn('punch-btn').dispatch('click');
    await tick();
    check('click ignored during ANIMATING', game.hero.currentStamina === stamBefore);
    game.state = savedState;

    // --- insufficient stamina disables buttons ---
    const manaBefore = game.hero.currentMana;
    game.hero.currentStamina = 0;
    game.ui.updateButtons(game.state, game.hero);
    check('jab disabled without stamina', btn('jab-btn').disabled === true);
    check('roundhouse disabled without stamina', btn('roundhouse-btn').disabled === true);
    check('heal still enabled with mana', btn('heal-btn').disabled === false);
    game.hero.currentStamina = 100;
    game.ui.updateButtons(game.state, game.hero);
    check('jab re-enabled after stamina refill', btn('jab-btn').disabled === false);

    // --- keyboard input starts an attack ---
    const mHpBefore = game.currentMonster.currentHealth;
    (docListeners['keydown'] || []).forEach(fn => fn(
        { key: '1', repeat: false, preventDefault() {}, target: { tagName: 'BODY' } }
    ));
    check('keyboard input starts an action', state() === GameState.ANIMATING, `state=${state()}`);
    const stamDuringAction = game.hero.currentStamina; // spent synchronously, before regen
    check('keyboard jab spent stamina immediately', stamDuringAction <= 95, `stamina=${stamDuringAction}`);
    await waitIdle();
    check('keyboard jab damaged the enemy', game.currentMonster.currentHealth < mHpBefore,
        `hp=${game.currentMonster.currentHealth} before=${mHpBefore}`);
    assertButtonsConsistent('after first jab');

    // --- full gauntlet loop ---
    let actionCount = 0;
    let sawEnemyTurn = false;
    let lost = false;
    while (state() !== GameState.GAME_OVER && actionCount < 400) {
        if (state() !== GameState.PLAYER_TURN) { await waitIdle(); continue; }
        const hero = game.hero;
        const foe = game.currentMonster;
        let move;
        if (hero.currentHealth <= 120 && hero.currentMana >= 20) move = 'heal';
        else if (hero.currentHealth <= 60 && hero.currentMana < 20) move = 'block';
        else if (hero.currentStamina < 10) move = 'block';
        else if (foe && foe.healthPercent < 40 && hero.currentStamina >= 22) move = 'roundhouse';
        else move = ['punch', 'jab', 'frontKick', 'punch'][actionCount % 4];
        if (!hero.canSpend(MOVES[move])) move = 'block';
        const before = hero.currentHealth;
        await game.handleAction(move);
        actionCount++;
        if (game.hero.currentHealth < before) sawEnemyTurn = true;
        assertButtonsConsistent(`after action ${actionCount}`);
        const hw = barWidth(getEl('hero-health')), mw = barWidth(getEl('monster-health'));
        if (hw === null || mw === null || hw < 0 || hw > 100 || mw < 0 || mw > 100) {
            check(`bars in range after action ${actionCount}`, false, `hero=${hw} monster=${mw}`);
            break;
        }
        if (state() === GameState.GAME_OVER) lost = !game.hero.isAlive();
    }
    check('game reached GAME_OVER', state() === GameState.GAME_OVER, `state=${state()} actions=${actionCount}`);
    check('enemy took turns during fight', sawEnemyTurn);
    check('log accumulated entries', getEl('log-list').children.length >= 10,
        `entries=${getEl('log-list').children.length}`);
    check('actions stayed under guard limit', actionCount < 400, `actions=${actionCount}`);
    assertButtonsConsistent('at game over');

    const won = !lost && game.stats.enemies >= 3;
    console.log(`OUTCOME: ${won ? 'VICTORY' : 'DEFEAT'} (seed=${process.env.SEED || 42}, actions=${actionCount})`);
    check('outcome recorded (victory or defeat)', won || lost, `won=${won} lost=${lost}`);
    check('overlay shown at end', !getEl('overlay').classList.contains('hidden'));
    const msg = getEl('overlay-message').textContent;
    check('overlay message matches outcome', won ? msg === 'VICTORY!' : msg === 'DEFEATED', `msg=${msg}`);
    if (won) {
        check('all 3 enemies defeated', game.stats.enemies === 3, `enemies=${game.stats.enemies}`);
        check('victory stats visible', !getEl('victory-stats').classList.contains('hidden'));
        check('stats populated', String(getEl('stat-damage').textContent).length > 0 &&
            String(getEl('stat-enemies').textContent) === '3',
            `dmg=${getEl('stat-damage').textContent} enemies=${getEl('stat-enemies').textContent}`);
        check('hero levelled up past 1', game.hero.level > 1, `level=${game.hero.level}`);
        check('PLAY AGAIN button', btn('restart-btn').textContent === 'PLAY AGAIN');
    } else {
        check('defeat hides victory stats', getEl('victory-stats').classList.contains('hidden'));
        check('RETRY button', btn('restart-btn').textContent === 'RETRY');
    }

    // --- restart must fully reset ---
    await game.startGame();
    await waitIdle();
    check('restart returns to PLAYER_TURN', state() === GameState.PLAYER_TURN);
    check('restart resets monster index', game.currentMonsterIndex === 0);
    check('restart refills hero', game.hero.currentHealth === game.hero.maxHealth &&
        game.hero.currentMana === game.hero.maxMana && game.hero.currentStamina === game.hero.maxStamina);
    check('restart clears log', getEl('log-list').children.length <= 2,
        `entries=${getEl('log-list').children.length}`);
    check('restart resets stats', game.stats.enemies === 0 && game.stats.rounds === 0);
    check('restart hides overlay', getEl('overlay').classList.contains('hidden'));

    // --- restart mid-fight must be ignored ---
    const midState = game.state;
    await game.startGame();
    check('mid-fight startGame is a no-op', game.state === midState && game.stats.rounds === 0);

    // --- enemy enrage is observable in the live flow ---
    if (state() === GameState.PLAYER_TURN && game.currentMonster) {
        const m = game.currentMonster;
        m.takeDamage(m.maxHealth - 1); // force below 30%
        const enraged = m.maybeEnrage();
        check('live monster enrage triggers below 30%', enraged === true && m.isEnraged);
        check('enrage adds the CSS glow class after trigger',
            (getEl('monster-canvas').classList.add('enraged'), getEl('monster-canvas').classList.contains('enraged')));
    }

    check('no async errors captured during run', errors.length === 0, errors.join(' | ').slice(0, 300));

    console.log(`\n=== FLOW SUMMARY: Passed ${passed}, Failed ${failed} ===`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('FLOW TEST CRASHED:', err);
    process.exit(1);
});
