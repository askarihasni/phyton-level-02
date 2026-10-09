// PHASE 7 — dedicated two-player input test.
//
// Drives the REAL VersusArena input methods (handleKeyDown / handleKeyUp /
// clearKeys) through the pure versusKeyOwner() router, in a DOM-stub sandbox.
// For every mapped key it asserts that exactly one fighter changes state, the
// other is untouched, and no wrong action fires. No browser required.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, 'rpg-arena', 'script.js'), 'utf8');

const sandbox = {
    document: { getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {}, hidden: false },
    window: { addEventListener: () => {}, removeEventListener: () => {}, AudioContext: null, webkitAudioContext: null, devicePixelRatio: 1 },
    Image: function () {},
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, console, Math, Promise
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + `
;globalThis.__exports = {
    VS, VS_ATTACKS, VERSUS_KEYS, VS_EDGE_ACTIONS, versusKeyOwner,
    VersusFighter, VersusArena, Character, GameController
};
`, sandbox);

const V = sandbox.__exports;
const { VERSUS_KEYS, VS_EDGE_ACTIONS, versusKeyOwner, VersusFighter, VersusArena, Character, GameController } = V;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

/* ------------------------- mock sprite / arena ------------------------- */
function makeClassList() {
    const set = new Set();
    return {
        add(...a) { a.forEach(x => set.add(x)); },
        remove(...a) { a.forEach(x => set.delete(x)); },
        toggle(x, on) { const v = on === undefined ? !set.has(x) : !!on; v ? set.add(x) : set.delete(x); return v; },
        contains(x) { return set.has(x); }
    };
}
function makeMockSprite() {
    return {
        canvas: { classList: makeClassList(), offsetWidth: 400, offsetLeft: 40 },
        rig: { head: { classList: makeClassList() }, arm: { classList: makeClassList() } },
        shadow: null, currentFrame: null, pose: null, rigParts: {},
        setFrame(n) { this.currentFrame = n; },
        setPose(x, y, sx, sy, r) { this.pose = { x, y, sx, sy, r }; },
        resetPose() { this.pose = null; },
        setRigPart(p, o) { this.rigParts[p] = o; },
        resetRig() { this.rigParts = {}; }
    };
}

// Build a fresh arena with two real fighters and per-fighter action counters.
function fresh() {
    const ui = {
        addLog() {}, setBar: () => 50, setTimer() {}, setTurn() {},
        showBanner() {}, showImpact() {}, showDamageNumber() {}
    };
    const anim = { contactPoint: () => ({ x: 0, y: 0 }), playKO: () => Promise.resolve() };
    const arena = new VersusArena({ ui, sprites: null, fx: { burst() {} }, anim, onEnd() {} });
    arena.running = true; arena.active = true; arena.over = false;
    arena.p1 = new VersusFighter({ player: 1, name: 'PLAYER 1', char: new Character('Player 1', 220, 20), sprite: makeMockSprite(), arena });
    arena.p2 = new VersusFighter({ player: 2, name: 'PLAYER 2', char: new Character('Player 2', 220, 20), sprite: makeMockSprite(), arena });
    arena.calls = { 1: [], 2: [] };
    for (const f of [arena.p1, arena.p2]) {
        const base = f.onAction;
        f.onAction = function (a) { arena.calls[f.player].push(a); return base.call(this, a); };
    }
    return arena;
}
const ev = (key, repeat = false, target = { tagName: 'BODY' }) => ({ key, repeat, preventDefault() {}, target });
const snap = (f) => ({
    state: f.state, onGround: f.onGround, attack: f.attack ? f.attack.action : null,
    input: { ...f.input }, forward: f.forward
});
const idleInput = (f) => f.input.left === false && f.input.right === false && f.input.crouch === false && f.input.block === false;

const MOVES = {
    w: [1, 'jump'], a: [1, 'left'], s: [1, 'crouch'], d: [1, 'right'], q: [1, 'block'], e: [1, 'dodge'],
    z: [1, 'punch'], x: [1, 'kick'], c: [1, 'heavy'], v: [1, 'special'],
    i: [2, 'jump'], j: [2, 'left'], k: [2, 'crouch'], l: [2, 'right'], u: [2, 'block'], o: [2, 'dodge'],
    b: [2, 'punch'], n: [2, 'kick'], m: [2, 'heavy'], p: [2, 'special']
};

console.log('\n=== 1. versusKeyOwner: exactly one owner per key ===');
{
    for (const [key, [player, action]] of Object.entries(MOVES)) {
        const owner = versusKeyOwner(key);
        check(`'${key}' -> P${player} ${action}`, !!owner && owner.player === player && owner.action === action, JSON.stringify(owner));
    }
    const p1keys = Object.keys(VERSUS_KEYS.p1), p2keys = Object.keys(VERSUS_KEYS.p2);
    check('key maps are disjoint (no key owns both fighters)', p1keys.filter(k => p2keys.includes(k)).length === 0);
    check('unrelated keys resolve to null', ['1', '2', 'h', 'r', 'y', 't', 'g', 'f', '0'].every(k => versusKeyOwner(k) === null));
    check('UPPERCASE is not silently accepted by the pure resolver (caller lowercases)',
        versusKeyOwner('A') === null);
}

console.log('\n=== 2. per-key keydown isolation + dispatch count ===');
for (const [key, [player, action]] of Object.entries(MOVES)) {
    const a = fresh();
    const own = player === 1 ? a.p1 : a.p2;
    const oth = player === 1 ? a.p2 : a.p1;
    const ret = a.handleKeyDown(ev(key));
    const edge = VS_EDGE_ACTIONS.has(action);
    const ownCalls = a.calls[player], othCalls = a.calls[player === 1 ? 2 : 1];

    check(`[${key}] keydown is consumed (preventDefault-able)`, ret === true);
    let ownOk;
    if (action === 'left') ownOk = own.input.left === true;
    else if (action === 'right') ownOk = own.input.right === true;
    else if (action === 'crouch') ownOk = own.input.crouch === true;
    else if (action === 'block') ownOk = own.input.block === true;
    else if (action === 'jump') ownOk = own.onGround === false;
    else if (action === 'dodge') ownOk = own.state === 'dodge';
    else ownOk = own.state === 'attack' && own.attack && own.attack.action === action;
    check(`[${key}] P${player} performs ${action}`, ownOk, JSON.stringify(snap(own)));
    check(`[${key}] P${player === 1 ? 2 : 1} is completely untouched`,
        idleInput(oth) && oth.state === 'idle' && oth.onGround === true && oth.attack === null,
        JSON.stringify(snap(oth)));
    check(`[${key}] action dispatched ${edge ? 'exactly once' : 'zero times'} on owner, never on the other`,
        (edge ? ownCalls.length === 1 : ownCalls.length === 0) && othCalls.length === 0,
        JSON.stringify({ own: ownCalls, oth: othCalls }));

    // release stops only the owner's held action
    a.handleKeyUp(ev(key));
    const ownRel = player === 1 ? a.p1 : a.p2;
    const othRel = player === 1 ? a.p2 : a.p1;
    check(`[${key}] release clears only P${player}'s held flag`,
        idleInput(ownRel) && idleInput(othRel), JSON.stringify(snap(ownRel)));
}

console.log('\n=== 3. key-repeat / double-dispatch guards ===');
{
    const a = fresh();
    a.handleKeyDown(ev('z'));
    a.handleKeyDown(ev('z'));                 // duplicate keydown while held
    a.handleKeyDown(ev('z', true));           // explicit browser repeat
    check('holding an attack fires only one action', a.calls[1].length === 1, JSON.stringify(a.calls[1]));

    const b = fresh();
    b.handleKeyDown(ev('d'));
    b.handleKeyDown(ev('d'));
    check('holding a movement key is idempotent', b.p1.input.right === true);

    const c = fresh();
    const rep = c.handleKeyDown(ev('z', true));
    check('a lone repeat of a mapped key is consumed but fires no action',
        rep === true && c.calls[1].length === 0 && c.p1.state === 'idle');
}

console.log('\n=== 4. ignored input ===');
{
    const a = fresh();
    check('unmapped key is not consumed', a.handleKeyDown(ev('h')) === false && a.calls[1].length === 0 && a.calls[2].length === 0);
    a.handleKeyDown(ev('1'));
    a.handleKeyDown(ev('y'));
    check('single-player/number keys change nothing', idleInput(a.p1) && idleInput(a.p2) && a.p1.state === 'idle' && a.p2.state === 'idle');

    const stopped = fresh();
    stopped.running = false;
    check('no input is consumed while the arena is stopped', stopped.handleKeyDown(ev('z')) === false && stopped.calls[1].length === 0);
}

console.log('\n=== 5. blur / clearKeys releases both fighters ===');
{
    const a = fresh();
    a.handleKeyDown(ev('d'));   // P1 right
    a.handleKeyDown(ev('j'));   // P2 left
    check('both held before blur', a.p1.input.right === true && a.p2.input.left === true);
    a.clearKeys();
    check('clearKeys drops every held flag on both fighters',
        idleInput(a.p1) && idleInput(a.p2) && a.keys.size === 0);
}

console.log('\n=== 6. simultaneous opposite movement ===');
{
    // D (P1 right) + J (P2 left) => both advance toward each other
    const toward = fresh();
    toward.handleKeyDown(ev('d')); toward.handleKeyDown(ev('j'));
    for (let i = 0; i < 30; i++) { toward.p1.advance(1 / 60, toward.p2); toward.p2.advance(1 / 60, toward.p1); }
    check('D + J: both fighters move toward each other in the same frames',
        toward.p1.forward > 0 && toward.p2.forward > 0, JSON.stringify({ p1: toward.p1.forward, p2: toward.p2.forward }));

    // A (P1 left) + L (P2 right) => both retreat, opposite screen directions
    const away = fresh();
    away.handleKeyDown(ev('a')); away.handleKeyDown(ev('l'));
    for (let i = 0; i < 30; i++) { away.p1.advance(1 / 60, away.p2); away.p2.advance(1 / 60, away.p1); }
    check('A + L: both fighters retreat simultaneously',
        away.p1.forward < 0 && away.p2.forward < 0, JSON.stringify({ p1: away.p1.forward, p2: away.p2.forward }));

    const oneWay = fresh();
    oneWay.handleKeyDown(ev('d'));   // only P1 moves
    for (let i = 0; i < 30; i++) { oneWay.p1.advance(1 / 60, oneWay.p2); oneWay.p2.advance(1 / 60, oneWay.p1); }
    check('D alone moves only P1', oneWay.p1.forward > 0 && oneWay.p2.forward === 0);
}

console.log('\n=== 7. simultaneous attacks, no cross-lock ===');
{
    const a = fresh();
    a.handleKeyDown(ev('z'));   // P1 punch
    a.handleKeyDown(ev('b'));   // P2 punch
    check('Z + B both enter attack state in the same frame',
        a.p1.state === 'attack' && a.p2.state === 'attack');

    // while P1 is mid-swing, P2 keeps moving
    const m = fresh();
    m.handleKeyDown(ev('z'));
    const before = m.p2.forward;
    m.handleKeyDown(ev('l'));   // P2 retreats
    for (let i = 0; i < 20; i++) { m.p1.advance(1 / 60, m.p2); m.p2.advance(1 / 60, m.p1); }
    check('P1 mid-attack does not freeze P2 movement',
        m.p1.state === 'attack' && Math.abs(m.p2.forward - before) > 1,
        JSON.stringify({ p1: m.p1.state, before, after: m.p2.forward }));

    // one fighter's stamina never blocks the other
    const s = fresh();
    s.p1.char.currentStamina = 0;
    s.handleKeyDown(ev('c'));    // P1 heavy refused (no stamina)
    s.handleKeyDown(ev('b'));    // P2 punch still works
    check('P1 out of stamina cannot block P2 attacking',
        s.p1.state !== 'attack' && s.p2.state === 'attack', JSON.stringify({ p1: s.p1.state, p2: s.p2.state }));
}

console.log('\n=== 8. GameController editable-target guard ===');
{
    const guard = (tag, editable) => GameController.prototype._isEditable.call({}, { tagName: tag, isContentEditable: editable });
    check('typing in <input> is ignored', guard('INPUT') === true);
    check('typing in <textarea> is ignored', guard('TEXTAREA') === true);
    check('typing in <select> is ignored', guard('SELECT') === true);
    check('contentEditable is ignored', guard('DIV', true) === true);
    check('normal body keys pass through', guard('BODY') === false);
    check('missing target passes through', GameController.prototype._isEditable.call({}, null) === false);
}

console.log('\n=== 9. exact required key maps ===');
{
    const REQ1 = { w: 'jump', a: 'left', s: 'crouch', d: 'right', q: 'block', e: 'dodge', z: 'punch', x: 'kick', c: 'heavy', v: 'special' };
    const REQ2 = { i: 'jump', j: 'left', k: 'crouch', l: 'right', u: 'block', o: 'dodge', b: 'punch', n: 'kick', m: 'heavy', p: 'special' };
    Object.entries(REQ1).forEach(([k, v2]) => check(`P1 '${k.toUpperCase()}' = ${v2}`, VERSUS_KEYS.p1[k] === v2, VERSUS_KEYS.p1[k]));
    Object.entries(REQ2).forEach(([k, v2]) => check(`P2 '${k.toUpperCase()}' = ${v2}`, VERSUS_KEYS.p2[k] === v2, VERSUS_KEYS.p2[k]));
}

console.log(`\n=== VERSUS-INPUT SUMMARY: Passed ${passed}, Failed ${failed} ===`);
process.exit(failed > 0 ? 1 : 0);
