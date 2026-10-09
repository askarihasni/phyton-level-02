// Node tests for the Phase-6 local 2-player versus engine.
// Runs script.js in a DOM-stub sandbox (same technique as test-logic.js) and
// exercises the pure pose/kinematics maths plus the VersusFighter state machine
// against a mock sprite — no browser required.
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
    VS, VS_ATTACKS, VERSUS_KEYS, VS_EDGE_ACTIONS,
    versusAttackPose, versusAttackDuration, versusHurtPose, versusHurtDuration,
    clampVersusForwards, VersusFighter, Character, CombatSystem,
    ANIM_PROFILES, REACTIONS, MOVES, GameState
};
`, sandbox);

const V = sandbox.__exports;
const { VS, VS_ATTACKS, VERSUS_KEYS, VS_EDGE_ACTIONS, versusAttackPose, versusAttackDuration,
    versusHurtPose, versusHurtDuration, clampVersusForwards, VersusFighter, Character,
    CombatSystem, ANIM_PROFILES, REACTIONS, MOVES } = V;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

/* ---------------- mock DOM sprite for VersusFighter ---------------- */
function makeClassList() {
    const set = new Set();
    return {
        add(...a) { a.forEach(x => set.add(x)); },
        remove(...a) { a.forEach(x => set.delete(x)); },
        toggle(x, on) { const v = on === undefined ? !set.has(x) : !!on; v ? set.add(x) : set.delete(x); return v; },
        contains(x) { return set.has(x); },
        _set: set
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
function makeFighter(player, name) {
    const arena = { over: false, active: true, ui: { addLog() {} }, landDust() {} };
    const sprite = makeMockSprite();
    const f = new VersusFighter({ player, name, char: new Character(name, 220, 20), sprite, arena });
    return { f, arena, sprite };
}

console.log('\n=== 1. KEY MAP: disjoint, complete, no cross-trigger ===');
{
    const p1 = Object.keys(VERSUS_KEYS.p1);
    const p2 = Object.keys(VERSUS_KEYS.p2);
    const overlap = p1.filter(k => p2.includes(k));
    check('P1 and P2 key sets are disjoint', overlap.length === 0, `overlap=${overlap.join(',')}`);
    check('P1 group is W A S D Q E Z X C V (+Space)',
        ['w', 'a', 's', 'd', 'q', 'e', 'z', 'x', 'c', 'v', ' '].every(k => p1.includes(k)), p1.join(''));
    check('P2 group is I J K L U O B N M P',
        ['i', 'j', 'k', 'l', 'u', 'o', 'b', 'n', 'm', 'p'].every(k => p2.includes(k)), p2.join(''));
    const actions = new Set(Object.values(VERSUS_KEYS.p1).concat(Object.values(VERSUS_KEYS.p2)));
    ['jump', 'left', 'right', 'crouch', 'block', 'dodge', 'punch', 'kick', 'heavy', 'special']
        .forEach(a => check(`action "${a}" mapped`, actions.has(a)));
    check('edge actions are the 6 discrete ones',
        VS_EDGE_ACTIONS.size === 6 && ['jump', 'dodge', 'punch', 'kick', 'heavy', 'special'].every(a => VS_EDGE_ACTIONS.has(a)),
        [...VS_EDGE_ACTIONS].join(','));
    check('held actions are not edge actions', !VS_EDGE_ACTIONS.has('left') && !VS_EDGE_ACTIONS.has('block'));
}

console.log('\n=== 2. VS_ATTACKS metadata (reuse of combat maths) ===');
{
    for (const [key, m] of Object.entries(VS_ATTACKS)) {
        check(`${key}: kind/range/accuracy/multiplier/hitLevel/sound present`,
            m.kind === 'attack' && m.range > 0 && m.accuracy > 0 && m.accuracy <= 1 &&
            m.multiplier > 0 && !!m.hitLevel && !!m.sound, JSON.stringify(m).slice(0, 80));
        check(`${key}: profile exists in ANIM_PROFILES`, !!ANIM_PROFILES[m.profile]);
    }
    check('special costs more than punch', VS_ATTACKS.special.staminaCost > VS_ATTACKS.punch.staminaCost);
}

console.log('\n=== 3. versusAttackPose phases + single impact marker ===');
{
    for (const [key, m] of Object.entries(VS_ATTACKS)) {
        const p = ANIM_PROFILES[m.profile];
        const dur = versusAttackDuration(p) * 1000;
        check(`${key}: duration > 0`, dur > 0, `dur=${dur}`);
        check(`${key}: returns null before start`, versusAttackPose(p, -1) === null);
        check(`${key}: returns null after end`, versusAttackPose(p, dur + 1) === null);
        // walk the whole timeline and detect the impact transition
        let firstImpact = -1, impactCount = 0, lastPhase = '';
        for (let t = 0; t <= dur + 20; t += 5) {
            const pose = versusAttackPose(p, t);
            if (!pose) break;
            lastPhase = pose.phase;
            if (pose.impact) { impactCount++; if (firstImpact < 0) firstImpact = t; }
        }
        check(`${key}: has an impact moment`, impactCount > 0 && firstImpact > 0, `first=${firstImpact}`);
        check(`${key}: impact starts during the strike phase`, firstImpact <= (p.windupMs + p.strikeMs), `first=${firstImpact}`);
        check(`${key}: settles before returning null`, lastPhase === 'settle', `last=${lastPhase}`);
        // peak reach is toward the opponent (x > windupX) and >= 0
        let maxX = -Infinity;
        for (let t = 0; t <= dur; t += 5) { const pose = versusAttackPose(p, t); if (pose) maxX = Math.max(maxX, pose.x); }
        check(`${key}: reaches toward the opponent (max x > 0)`, maxX > 0, `maxX=${maxX}`);
        if (p.lift) {
            let minY = Infinity;
            for (let t = 0; t <= dur; t += 5) { const pose = versusAttackPose(p, t); if (pose) minY = Math.min(minY, pose.y); }
            check(`${key}: kick lifts the body (min y < 0)`, minY < 0, `minY=${minY}`);
        }
    }
}

console.log('\n=== 4. versusHurtPose + REACTIONS presets ===');
{
    for (const tier of ['light', 'low', 'heavy', 'crit']) {
        const r = REACTIONS[tier];
        const d = versusHurtDuration(r) * 1000;
        check(`${tier}: duration > 0`, d > 0);
        const start = versusHurtPose(r, 0);
        const end = versusHurtPose(r, d + 500);
        check(`${tier}: start pose defined`, !!start);
        check(`${tier}: returns to rest x`, Math.abs(end.x) < 1e-6, `x=${end.x}`);
        check(`${tier}: carries a head deflection`, typeof start.headDeg === 'number');
    }
}

console.log('\n=== 5. clampVersusForwards bounds ===');
{
    const [a, b] = clampVersusForwards(400, 400, VS.MIN_FORWARD, VS.MAX_FORWARD, 300);
    check('combined approach never exceeds maxApproach', a + b <= 300 + 1e-6, `sum=${a + b}`);
    check('each forward respects MAX_FORWARD', a <= VS.MAX_FORWARD + 1e-6 && b <= VS.MAX_FORWARD + 1e-6);
    const [c, d] = clampVersusForwards(-999, -999, VS.MIN_FORWARD, VS.MAX_FORWARD, 300);
    check('each forward respects MIN_FORWARD', c >= VS.MIN_FORWARD - 1e-6 && d >= VS.MIN_FORWARD - 1e-6);
    const [e, f] = clampVersusForwards(100, 100, VS.MIN_FORWARD, VS.MAX_FORWARD, 300);
    check('within-bounds values pass through', e === 100 && f === 100);
}

console.log('\n=== 6. VersusFighter movement (independent, mirrored) ===');
{
    const P1 = makeFighter(1, 'P1');
    P1.f.input.right = true;
    for (let i = 0; i < 30; i++) P1.f.advance(1 / 60, null);
    check('P1 D/right moves toward opponent (+forward)', P1.f.forward > 0, `f=${P1.f.forward}`);
    check('P1 walking state', P1.f.state === 'walk' || P1.f.state === 'idle');

    const P1b = makeFighter(1, 'P1');
    P1b.f.input.left = true;
    for (let i = 0; i < 30; i++) P1b.f.advance(1 / 60, null);
    check('P1 A/left retreats (-forward)', P1b.f.forward < 0, `f=${P1b.f.forward}`);

    const P2 = makeFighter(2, 'P2');
    P2.f.input.right = true;   // P2 "L" = screen-right = backward for P2
    for (let i = 0; i < 30; i++) P2.f.advance(1 / 60, null);
    check('P2 L/right retreats (flipped sign)', P2.f.forward < 0, `f=${P2.f.forward}`);

    const P2b = makeFighter(2, 'P2');
    P2b.f.input.left = true;   // P2 "J" = screen-left = forward
    for (let i = 0; i < 30; i++) P2b.f.advance(1 / 60, null);
    check('P2 J/left advances toward opponent', P2b.f.forward > 0, `f=${P2b.f.forward}`);
}

console.log('\n=== 7. jump / crouch / block / dodge states ===');
{
    const J = makeFighter(1, 'P1');
    J.f.onAction('jump');
    check('jump leaves the ground', J.f.onGround === false && J.f.y > 0, `y=${J.f.y}`);
    let landed = false;
    for (let i = 0; i < 240; i++) { J.f.advance(1 / 60, null); if (J.f.onGround && J.f.state === 'idle') { landed = true; break; } }
    check('jump eventually lands back on the ground', landed && J.f.y === 0, `y=${J.f.y}`);

    const C = makeFighter(1, 'P1');
    C.f.input.crouch = true;
    C.f.advance(1 / 60, null);
    check('holding crouch enters crouch state', C.f.state === 'crouch', C.f.state);

    const B = makeFighter(1, 'P1');
    B.f.input.block = true;
    B.f.advance(1 / 60, null);
    check('holding block enters block state', B.f.state === 'block', B.f.state);
    check('blocking sets combat stance', B.f.currentStance() === 'block');

    const D = makeFighter(1, 'P1');
    D.f.onAction('dodge');
    check('dodge grants i-frames', D.f.iFrames > 0 && D.f.state === 'dodge');
    const before = D.f.forward;
    D.f.advance(1 / 60, null);
    check('dodge slips away from the opponent', D.f.forward < before, `before=${before} after=${D.f.forward}`);
    check('dodge has a cooldown', D.f.dodgeCd > 0);
}

console.log('\n=== 8. attacks: cost, single impact, recovery ===');
{
    for (const key of Object.keys(VS_ATTACKS)) {
        const A = makeFighter(1, 'P1');
        const before = A.f.char.currentStamina;
        A.f.onAction(key);
        check(`${key}: enters attack state`, A.f.state === 'attack' && !!A.f.attack, A.f.state);
        check(`${key}: spends stamina`, A.f.char.currentStamina < before, `${before} -> ${A.f.char.currentStamina}`);
        // step through the whole attack; count impact transitions
        let impacts = 0, seen = false;
        for (let i = 0; i < 600 && A.f.state === 'attack'; i++) {
            A.f.advance(1 / 60, null);
            if (A.f.attack && A.f.attack.impactPending && !seen) { impacts++; seen = true; }
        }
        check(`${key}: resolves exactly one impact per attack`, impacts === 1, `impacts=${impacts}`);
        check(`${key}: returns to idle after the swing`, A.f.state === 'idle', A.f.state);
    }
    // unaffordable attack is refused
    const poor = makeFighter(1, 'P1');
    poor.f.char.currentStamina = 0;
    poor.f.onAction('heavy');
    check('attack refused without stamina', poor.f.attack === null && poor.f.state !== 'attack');
    // attack cannot restart mid-swing
    const busy = makeFighter(1, 'P1');
    busy.f.onAction('punch');
    const firstAttack = busy.f.attack;
    busy.f.onAction('punch');
    check('cannot chain a second attack mid-swing', busy.f.attack === firstAttack);
}

console.log('\n=== 9. simultaneous attacks both land (independence) ===');
{
    const P1 = makeFighter(1, 'P1');
    const P2 = makeFighter(2, 'P2');
    P1.f.onAction('punch');
    P2.f.onAction('kick');
    let p1Pending = false, p2Pending = false;
    for (let i = 0; i < 600; i++) {
        P1.f.advance(1 / 60, P2.f);
        P2.f.advance(1 / 60, P1.f);
        if (P1.f.attack && P1.f.attack.impactPending) p1Pending = true;
        if (P2.f.attack && P2.f.attack.impactPending) p2Pending = true;
        if (P1.f.state === 'idle' && P2.f.state === 'idle') break;
    }
    check('both fighters reached their own impact frame', p1Pending && p2Pending);
}

console.log('\n=== 10. hit reaction + KO ===');
{
    const H = makeFighter(2, 'P2');
    H.f.onHit({ damage: 20, isCritical: false, heavy: false, low: false });
    check('taking a hit enters hurt state', H.f.state === 'hurt');
    check('hurt clears any in-flight attack', H.f.attack === null);
    for (let i = 0; i < 300 && H.f.state === 'hurt'; i++) H.f.advance(1 / 60, null);
    check('hurt reaction recovers to idle', H.f.state === 'idle', H.f.state);

    const K = makeFighter(1, 'P1');
    K.f.char.takeDamage(999);
    check('character is dead at 0 HP', !K.f.char.isAlive());
    K.f.startKO();
    check('KO state entered', K.f.state === 'ko');
}

console.log('\n=== 11. CombatSystem reuse for versus moves ===');
{
    // rollAttack must accept VS_ATTACKS entries (same shape as MOVES)
    const attacker = new Character('A', 220, 20);
    let rolls = 0, crits = 0;
    for (let i = 0; i < 400; i++) {
        const r = CombatSystem.rollAttack(attacker, VS_ATTACKS.punch);
        if (!r.missed) { rolls++; if (r.isCritical) crits++; }
    }
    check('rollAttack accepts a VS attack', rolls > 0, `rolls=${rolls}`);
    check('criticals occur', crits > 0, `crits=${crits}`);

    const defender = new Character('D', 220, 20);
    defender.stance = 'block';
    const blocked = CombatSystem.resolveIncoming(defender, 100, VS_ATTACKS.heavy);
    check('block reduces incoming damage', blocked.blocked === true && blocked.damage < 100, JSON.stringify(blocked));
    defender.stance = 'crouch';
    const crouched = CombatSystem.resolveIncoming(defender, 100, { hitLevel: 'mid' });
    check('crouch reduces mid damage', crouched.crouched === true && crouched.damage < 100);
    const evaded = CombatSystem.resolveIncoming(defender, 100, { hitLevel: 'high' });
    check('crouch evades high attacks', evaded.evaded === true && evaded.damage === 0);
    // takeDamage returns the applied amount and clamps at 0
    const d2 = new Character('D2', 50, 10);
    check('takeDamage returns applied damage', d2.takeDamage(30) === 30 && d2.currentHealth === 20);
    check('overkill clamps health to zero', d2.takeDamage(999) === 999 && d2.currentHealth === 0);
}

console.log('\n=== 12. game states preserved for single-player ===');
{
    check('GameState.START intact', V.GameState.START === 'START');
    check('GameState.PLAYER_TURN intact', V.GameState.PLAYER_TURN === 'PLAYER_TURN');
    check('GameState.VICTORY/DEFEAT/GAME_OVER intact',
        V.GameState.VICTORY === 'VICTORY' && V.GameState.DEFEAT === 'DEFEAT' && V.GameState.GAME_OVER === 'GAME_OVER');
    check('MOVES registry untouched (special still heroOnly)', MOVES.special.heroOnly === true);
}

console.log(`\n=== VERSUS SUMMARY: Passed ${passed}, Failed ${failed} ===`);
process.exit(failed > 0 ? 1 : 0);
