// Static wiring check: JS DOM ids vs HTML ids, data-move keys vs MOVES, assets.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'rpg-arena');
const js = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
};

// 1. Every getElementById target exists in the HTML
const jsIds = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const missingIds = [...new Set(jsIds)].filter(id => !htmlIds.has(id));
check(`all ${new Set(jsIds).size} JS-referenced element IDs exist in HTML`, missingIds.length === 0,
    `missing: ${missingIds.join(', ')}`);

// 2. Every data-move in HTML is a real move in MOVES
const dataMoves = [...html.matchAll(/data-move="([^"]+)"/g)].map(m => m[1]);
const movesStart = js.indexOf('const MOVES');
const movesEnd = js.indexOf('const ANIM_PROFILES');
const movesBlock = js.slice(movesStart, movesEnd);
const declaredMoves = new Set([...movesBlock.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]));
const badMoves = dataMoves.filter(m => !declaredMoves.has(m));
check(`all ${dataMoves.length} data-move attributes map to MOVES entries`, badMoves.length === 0,
    `unknown: ${badMoves.join(', ')}`);

// 3. Every button the UI controller expects exists
const uiBtnRefs = [...js.matchAll(/(\w+):\s*document\.getElementById\('([\w-]+-btn)'\)/g)];
const missingBtns = uiBtnRefs.filter(m => !htmlIds.has(m[2]));
check(`all ${uiBtnRefs.length} action buttons referenced by UIController exist`, missingBtns.length === 0,
    `missing: ${missingBtns.map(m => m[2]).join(', ')}`);

// 4. Every button with data-move is reachable from UI.controls
const htmlBtnIds = [...html.matchAll(/id="([\w-]+-btn)"[^>]*data-move/g)].map(m => m[1]);
const uiBlock = js.slice(js.indexOf('controls: {'), js.indexOf('panel:'));
const uiBtnIds = [...uiBlock.matchAll(/getElementById\('([\w-]+-btn)'\)/g)].map(m => m[1]);
const unwired = htmlBtnIds.filter(id => !uiBtnIds.includes(id));
check(`all ${htmlBtnIds.length} move-buttons are wired in UI.controls`, unwired.length === 0,
    `unwired: ${unwired.join(', ')}`);

// 5. Asset references resolve to real files
const assetRefs = [...js.matchAll(/'((?:assets\/)[^']+)'/g)].map(m => m[1])
    .concat([...html.matchAll(/src="(assets\/[^"]+)"/g)].map(m => m[1]));
const missingAssets = [...new Set(assetRefs)].filter(p => !fs.existsSync(path.join(dir, p)));
check(`all ${new Set(assetRefs).size} asset references exist on disk`, missingAssets.length === 0,
    `missing: ${missingAssets.join(', ')}`);

// 6. Keyboard map only references real moves
const kmStart = js.indexOf('const KEY_MAP');
const kmEnd = js.indexOf('document.addEventListener', kmStart);
const keyMapBlock = js.slice(kmStart, kmEnd);
const mappedMoves = [...keyMapBlock.matchAll(/:\s*'(\w+)'/g)].map(m => m[1]);
const badKeys = mappedMoves.filter(m => !declaredMoves.has(m));
check('keyboard map references only real moves', badKeys.length === 0, `unknown: ${badKeys.join(', ')}`);

// 7. Every attack move has an animation profile
const attackMoves = [...movesBlock.matchAll(/kind:\s*'attack'.*?anim:\s*'(\w+)'/gs)].map(m => m[1]);
const profilesBlock = js.slice(js.indexOf('const ANIM_PROFILES'), js.indexOf('/* ========================= COMBAT'));
const profileKeys = [...profilesBlock.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]);
const noProfile = attackMoves.filter(a => !profileKeys.includes(a));
check(`all ${attackMoves.length} attack animations have profiles`, noProfile.length === 0,
    `missing: ${noProfile.join(', ')}`);

// 8. CSS classes used by JS animations exist in the stylesheet
const requiredCss = ['ko-hero', 'ko-monster', 'brace-hero', 'brace-monster', 'dodge-hero', 'dodge-monster',
    'crouch-hero', 'crouch-monster', 'knockback-hero', 'knockback-monster', 'recoil-hero', 'recoil-monster',
    'enraged', 'hurt-state', 'healing', 'is-punching', 'is-kicking', 'impact-text', 'damage-number',
    'screen-shake', 'flash-red', 'overlay-open', 'enemy-turn', 'hidden', 'low', 'victory', 'start'];
const missingCss = requiredCss.filter(c => !css.includes(`.${c}`));
check(`all ${requiredCss.length} JS-driven CSS classes are styled`, missingCss.length === 0,
    `missing: ${missingCss.join(', ')}`);

// 9. No placeholder / fake functionality markers
const placeholders = [...js.matchAll(/TODO|FIXME|coming soon|implement later|placeholder/gi)];
check('no placeholder markers in script.js', placeholders.length === 0);

// 10. No inline styles scattered through game logic (should be in CSS or centralized UI)
const inlineStyles = [...js.matchAll(/\.style\.\w+\s*=/g)].length;
check('style writes are centralized (<= 20 sites)', inlineStyles <= 20, `found ${inlineStyles}`);

console.log(`\n=== WIRING SUMMARY: Passed ${passed}, Failed ${failed} ===`);
process.exit(failed > 0 ? 1 : 0);
