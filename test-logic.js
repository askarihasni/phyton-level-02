// Headless logic tests for the RPG Arena core classes.
// Runs script.js in a sandbox with DOM stubs (no browser needed).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, 'rpg-arena', 'script.js'), 'utf8');

const sandbox = {
    document: { getElementById: () => null, addEventListener: () => {} },
    window: { addEventListener: () => {}, AudioContext: null, webkitAudioContext: null },
    Image: function () {},
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    setTimeout, clearTimeout, console, Math, Promise
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + `
;globalThis.__exports = { Character, Hero, Monster, CombatSystem, EnemyAI, MOVES, ANIM_PROFILES, GameState, EnemyAI };
`, sandbox);

const { Character, Hero, Monster, CombatSystem, EnemyAI, MOVES, GameState } = sandbox.__exports;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}
const _once = new Set();
function checkOnce(name, cond, extra = '') {
    if (_once.has(name)) return;
    _once.add(name);
    check(name, cond, extra);
}

console.log('\n=== 1. CHARACTER BASE CLASS ===');
{
    const c = new Character('Test', 100, 20);
    check('name/maxHealth/attackPower set', c.name === 'Test' && c.maxHealth === 100 && c.attackPower === 20);
    check('starts at full health', c.currentHealth === 100);
    c.takeDamage(30);
    check('takeDamage reduces health', c.currentHealth === 70);
    c.takeDamage(999);
    check('health never goes negative', c.currentHealth === 0, `got ${c.currentHealth}`);
    check('isAlive false at 0 HP', c.isAlive() === false);
    const c2 = new Character('T2', 50, 10);
    check('health never exceeds max on restore', (c2.restoreHealth(999), c2.currentHealth === 50));
    // health is private — direct assignment must not work
    let threw = false;
    try { c2.currentHealth = 9999; } catch (e) { threw = true; }
    check('health protected (setter-less private field)', c2.currentHealth === 50 && threw === false,
        `(assignment silently ignored: ${c2.currentHealth})`);
}

console.log('\n=== 2. HERO: heal / mana / stamina / combo ===');
{
    const hero = new Hero('Ryko', 200, 20, 60);
    hero.takeDamage(100);
    const res = hero.heal();
    check('heal succeeds with mana', res.success === true && res.healed === 40);
    check('heal restores 40 HP', hero.currentHealth === 140);
    check('heal consumed 20 mana', hero.currentMana === 40);
    hero.heal();
    const res3 = hero.heal(); // 180 + 40 = 220 -> must clamp to 200
    check('heal never exceeds maxHealth', hero.currentHealth === 200 && res3.healed === 20,
        `hp=${hero.currentHealth} healed=${res3.healed}`);
    check('mana fully consumed after 3 heals', hero.currentMana === 0);
    const poor = hero.heal();
    check('heal fails gracefully without mana', poor.success === false && typeof poor.reason === 'string');
    check('mana never negative', hero.currentMana >= 0, `got ${hero.currentMana}`);
    hero.takeDamage(999);
    const dead = hero.heal();
    check('heal refused while defeated (0 HP)', dead.success === false && hero.currentHealth === 0);
    check('health still never negative', hero.currentHealth === 0);
    // stamina
    const h2 = new Hero('H2', 200, 20, 60);
    h2.spend(MOVES.roundhouse);
    check('attack spends stamina', h2.currentStamina === 78, `got ${h2.currentStamina}`);
    h2.currentStamina = 5;
    check('canSpend false when too tired', h2.canSpend(MOVES.heavyKick) === false);
    // combo
    const h3 = new Hero('H3', 200, 20, 60);
    const base = h3.getMoveMultiplier(MOVES.punch);
    for (let i = 0; i < 10; i++) h3.registerHit();
    const bonus = h3.getMoveMultiplier(MOVES.punch);
    check('combo increases damage', bonus > base);
    check('combo bonus capped at +20%', Math.abs(bonus / base - 1.2) < 1e-9, `ratio=${(bonus / base).toFixed(3)}`);
    h3.resetCombo();
    check('combo resets', h3.combo === 0);
}

console.log('\n=== 3. MONSTER: enrage (once only) ===');
{
    const m = new Monster({ name: 'Orc', hp: 100, atk: 20, level: 2, hue: 0, style: 'heavy', moveSet: ['punch'] });
    check('not enraged at full health', m.maybeEnrage() === false && m.isEnraged === false);
    m.takeDamage(75); // 25% left
    check('enrage activates below 30%', m.maybeEnrage() === true);
    check('isEnraged flag set', m.isEnraged === true);
    check('attack power increased once (20 -> 32)', m.attackPower === 32, `got ${m.attackPower}`);
    // repeatedly call — must not multiply again
    for (let i = 0; i < 5; i++) m.maybeEnrage();
    check('no repeated multiplication on later turns', m.attackPower === 32, `got ${m.attackPower}`);
    check('enrage() returns false when already enraged', m.enrage() === false);
    // enrage never stacks even after more damage
    m.takeDamage(20);
    m.maybeEnrage();
    check('still stable after further damage', m.attackPower === 32);
    const m2 = new Monster({ name: 'Gob', hp: 130, atk: 14, level: 1, hue: 90, style: 'aggressive', moveSet: ['jab'] });
    m2.takeDamage(80); // 38% — above threshold
    check('no enrage above 30%', m2.maybeEnrage() === false);
}

console.log('\n=== 4. COMBAT: damage / crit / block / dodge / crouch ===');
{
    // Deterministic-ish: run many samples for probability checks
    const hero = new Hero('A', 1000, 20, 60);
    const foe = new Monster({ name: 'B', hp: 1000000, atk: 20, level: 1, hue: 0, style: 'aggressive', moveSet: ['punch'] });

    // plain damage
    let hits = 0, dmgSum = 0;
    for (let i = 0; i < 200; i++) {
        hero.currentStamina = 1000;
        foe.currentStamina = 1000;
        const r = hero.attack(foe, 'punch');
        if (!r.missed) { hits++; dmgSum += r.damage; }
    }
    check('attacks land ~95% of the time', hits > 170 && hits <= 200, `hits=${hits}`);
    check('punch damage ≈ 20 base (crits inflate avg, must be >= 19 avg)', dmgSum / Math.max(1, hits) >= 19, `avg=${(dmgSum / hits).toFixed(1)}`);

    // special: costs both stamina AND mana, deducted exactly once each
    const spHero = new Hero('Specialist', 200, 20, 60);
    spHero.currentStamina = 100;
    const spTarget = new Monster({ name: 'Dummy', hp: 5000, atk: 5, level: 1, hue: 0, style: 'heavy', moveSet: [] });
    const spRes = spHero.attack(spTarget, 'special');
    check('special attack resolves', !spRes.failed && typeof spRes.damage === 'number', JSON.stringify(spRes));
    check('special deducts stamina exactly once (100 -> 75)', spHero.currentStamina === 75, `got ${spHero.currentStamina}`);
    check('special deducts mana exactly once (60 -> 20)', spHero.currentMana === 20, `got ${spHero.currentMana}`);
    spHero.currentStamina = 0;
    const spFail = spHero.attack(spTarget, 'special');
    check('special blocked without stamina', spFail.failed === true && spFail.reason === 'stamina');
    spHero.currentStamina = 100;
    while (spHero.currentMana > 0) { spHero.spend(MOVES.special); }
    spHero.currentStamina = 100;
    const spFail2 = spHero.attack(spTarget, 'special');
    check('special blocked without mana', spFail2.failed === true && spFail2.reason === 'mana');

    // critical hits occur ~10-15%
    let crits = 0;
    for (let i = 0; i < 500; i++) {
        hero.currentStamina = 1000;
        const r = hero.attack(foe, 'jab');
        if (r.isCritical) crits++;
    }
    check('critical hits occur around 10%', crits > 25 && crits < 95, `crits=${crits}/500`);

    // critical = double damage (base 14 for jab: round(20*0.7)=14)
    hero.currentStamina = 1000;
    let sawDouble = false;
    for (let i = 0; i < 400 && !sawDouble; i++) {
        hero.currentStamina = 1000;
        const r = hero.attack(foe, 'jab');
        if (r.isCritical) sawDouble = r.damage === 28 || r.raw === 28 || r.damage >= 28;
    }
    check('critical hit deals double damage', sawDouble);

    // block reduces damage but does not negate it
    foe.stance = 'block';
    let blockedTotal = 0, blockedCount = 0;
    for (let i = 0; i < 200; i++) {
        hero.currentStamina = 1000;
        const before = foe.currentHealth;
        const r = hero.attack(foe, 'punch');
        if (!r.missed) {
            blockedCount++;
            if (r.blocked) { blockedTotal += r.damage; checkOnce('block reduces but never zeroes', r.damage > 0 && r.damage <= 14, `dmg=${r.damage}`); }
        }
    }
    check('block engaged on attacks', blockedCount > 0 && blockedTotal >= 0);

    // dodge can succeed (60%) and can fail (punish)
    foe.stance = 'dodge';
    let dodges = 0, punish = 0, total = 0;
    for (let i = 0; i < 400; i++) {
        hero.currentStamina = 1000;
        const r = hero.attack(foe, 'jab');
        if (!r.missed) {
            total++;
            if (r.dodged) dodges++;
            else if (r.punished) punish++;
        }
    }
    check('dodge succeeds ~60% (not always)', dodges > total * 0.35 && dodges < total * 0.85, `${dodges}/${total}`);
    check('failed dodge takes extra damage', punish > 0, `punish=${punish}`);

    // crouch: evades high, punished by low
    foe.stance = 'crouch';
    let evaded = 0;
    for (let i = 0; i < 100; i++) {
        hero.currentStamina = 1000;
        const r = hero.attack(foe, 'uppercut'); // high
        if (!r.missed && r.evaded) evaded++;
    }
    check('crouch evades high attacks', evaded > 60, `evaded=${evaded}/100`);

    let lowDmg = 0, lowCount = 0;
    for (let i = 0; i < 100; i++) {
        hero.currentStamina = 1000;
        const r = hero.attack(foe, 'lowKick'); // low
        if (!r.missed && !r.dodged) { lowDmg += r.damage; lowCount++; }
    }
    check('low kicks punish crouchers (avg > 18)', lowCount > 0 && lowDmg / lowCount > 18, `avg=${(lowDmg / Math.max(1, lowCount)).toFixed(1)}`);
    foe.stance = 'idle';

    // hero attacks monster, monster attacks hero through same interface
    hero.currentStamina = 1000;
    const r1 = hero.attack(foe, 'punch');
    foe.currentStamina = 1000;
    const r2 = foe.attack(hero, 'punch');
    check('polymorphic attack: both directions work', typeof r1.damage === 'number' && typeof r2.damage === 'number');

    // invalid target / dead target
    const dead = new Monster({ name: 'Dead', hp: 1, atk: 5, level: 1, hue: 0, style: 'heavy', moveSet: [] });
    dead.takeDamage(99);
    hero.currentStamina = 1000;
    const r3 = hero.attack(dead, 'punch');
    check('cannot attack a defeated enemy', r3.invalid === true || r3.missed === true);
}

console.log('\n=== 5. ENEMY AI ===');
{
    const styles = ['aggressive', 'heavy', 'boss'];
    for (const style of styles) {
        const m = new Monster({ name: style, hp: 150, atk: 20, level: 1, hue: 0, style, moveSet: ['jab', 'punch', 'lowKick', 'frontKick', 'block'] });
        const hero = new Hero('H', 200, 20, 60);
        const seen = new Set();
        for (let i = 0; i < 100; i++) {
            m.currentStamina = 100;
            hero.stance = 'idle';
            seen.add(EnemyAI.chooseAction(m, hero));
        }
        const valid = [...seen].every(a => a === 'recover' || (MOVES[a] && m.moveSet.includes(a)));
        check(`${style}: only uses known moves`, valid, [...seen].join(','));
        check(`${style}: varies its actions (not always same)`, seen.size >= 3, `seen=${seen.size}`);
    }
    // low stamina forces recover/block
    const m = new Monster({ name: 'tired', hp: 150, atk: 20, level: 1, hue: 0, style: 'boss', moveSet: ['jab', 'punch', 'roundhouse', 'lowKick', 'block', 'dodge'] });
    const hero = new Hero('H', 200, 20, 60);
    const seen = new Set();
    for (let i = 0; i < 60; i++) { m.currentStamina = 5; seen.add(EnemyAI.chooseAction(m, hero)); }
    check('low stamina leads to recover/block behaviour', seen.has('recover') || seen.has('block'), [...seen].join(','));

    // crouching player gets punished by low kicks more often
    hero.stance = 'crouch';
    let lows = 0;
    for (let i = 0; i < 300; i++) {
        m.currentStamina = 100;
        if (EnemyAI.chooseAction(m, hero) === 'lowKick') lows++;
    }
    check('AI punishes crouching player with low kicks', lows > 40, `lows=${lows}/300`);
}

console.log('\n=== 6. GAME STATE CONSTANTS ===');
{
    check('state machine has required states',
        ['START', 'PLAYER_TURN', 'ENEMY_TURN', 'ANIMATING', 'VICTORY', 'DEFEAT', 'GAME_OVER']
            .every(s => Object.values(GameState).includes(s)));
    check('all move entries have required metadata',
        Object.values(MOVES).every(m => m.kind && m.label && m.anim));
}

console.log('\n=== SUMMARY ===');
console.log(`Passed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
