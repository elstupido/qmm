#!/usr/bin/env node
// Pure-logic harness for server/lore.mjs — no model, no server. Run: node tools/lore-test.mjs
// Mirrors the shared contract; the Kotlin engine must pass the same scenarios by inspection.

import { scanLore, resolveMacros, applyRails, freshLoreFx } from '../server/lore.mjs';

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const CTX = 32768; // budget math input — any window works, budgets are % of it

const pack = {
  lore: {
    budget_pct: 10,
    scan_depth: 4,
    entries: [
      { id: 'const-setting', constant: true, order: 10, content: 'the kokugikan is empty at night.', keys: [] },
      { id: 'ura-knees', keys: ['ura', 'knees'], order: 100, content: 'ura retired because his knees gave out.' },
      { id: 'regex-dohyo', keys: ['/dohy[oō]/i'], order: 90, content: 'the practice dohyo was rebuilt last spring.' },
      { id: 'late-scrape', keys: ['sound', 'noise'], delay: 5, order: 80, content: 'the scraping under the floor again.' },
      { id: 'cool-down', keys: ['kenji'], cooldown: 3, order: 70, content: 'kenji never missed a morning practice.' },
      { id: 'stick-copper', keys: ['smell'], sticky: 2, order: 60, content: 'that copper smell is getting stronger.' },
      { id: 'cold-draft', keys: ['cold'], group: 'coldspot', order: 50, content: 'there is a draft from the storeroom.' },
      { id: 'cold-breath', keys: ['freezing'], group: 'coldspot', order: 50, content: 'it feels like something is breathing on her.' },
      { id: 'never-prob', keys: ['ura'], probability: 0, order: 40, content: 'THIS MUST NEVER FIRE.' },
    ],
  },
  rails: [
    { find: '^(okay|yeah you\\u2019re right|yeah you\'re right)[,.!\\s]*', replace: '', flags: 'i' },
    { find: 'hands shaking', replace: 'jaw tight', flags: 'gi' },
  ],
};

const t = (who, text) => ({ who, text });

// --- 1. constant + keyword + regex ------------------------------------------
{
  const state = { turn: 1, lore_fx: freshLoreFx() };
  const r = scanLore(pack, [t('user', 'what happened to Ura?'), t('yuki', 'i am near the dohyo')], state, CTX);
  ok('constant always fires', r.fired.includes('const-setting'));
  ok('keyword fires (case-insensitive)', r.fired.includes('ura-knees'));
  ok('regex key fires', r.fired.includes('regex-dohyo'));
  ok('probability 0 never fires', !r.fired.includes('never-prob'));
  ok('order sorts block (ura first)', r.block.indexOf('knees gave out') < r.block.indexOf('kokugikan is empty'));
}

// --- 2. delay ----------------------------------------------------------------
{
  const state = { turn: 2, lore_fx: freshLoreFx() };
  const r1 = scanLore(pack, [t('user', 'i heard a sound')], state, CTX);
  ok('delay blocks early fire (turn 2 < delay 5)', !r1.fired.includes('late-scrape'));
  state.turn = 6;
  const r2 = scanLore(pack, [t('user', 'i heard a sound')], state, CTX);
  ok('delay releases later (turn 6 >= 5)', r2.fired.includes('late-scrape'));
}

// --- 3. cooldown -------------------------------------------------------------
{
  const state = { turn: 1, lore_fx: freshLoreFx() };
  const r1 = scanLore(pack, [t('user', 'tell me about kenji')], state, CTX);
  ok('cooldown entry fires once', r1.fired.includes('cool-down'));
  state.turn = 2;
  const r2 = scanLore(pack, [t('user', 'kenji again')], state, CTX);
  ok('cooldown blocks refire (turn 2 <= 1+3)', !r2.fired.includes('cool-down'));
  state.turn = 5;
  const r3 = scanLore(pack, [t('user', 'kenji once more')], state, CTX);
  ok('cooldown expires (turn 5 > 4)', r3.fired.includes('cool-down'));
}

// --- 4. sticky ---------------------------------------------------------------
{
  const state = { turn: 1, lore_fx: freshLoreFx() };
  scanLore(pack, [t('user', 'what is that smell')], state, CTX);
  state.turn = 2;
  const r2 = scanLore(pack, [t('user', 'i moved on to other things')], state, CTX);
  ok('sticky persists without keys (turn 2 <= 1+2)', r2.fired.includes('stick-copper'));
  state.turn = 4;
  const r3 = scanLore(pack, [t('user', 'still other things')], state, CTX);
  ok('sticky expires (turn 4 > 3)', !r3.fired.includes('stick-copper'));
}

// --- 5. equivoque group lock -------------------------------------------------
{
  const state = { turn: 1, lore_fx: freshLoreFx() };
  const r1 = scanLore(pack, [t('user', 'it is so cold in here')], state, CTX);
  ok('group member A fires', r1.fired.includes('cold-draft'));
  state.turn = 2;
  const r2 = scanLore(pack, [t('user', 'i am freezing and cold')], state, CTX);
  ok('group canon locks out member B forever', !r2.fired.includes('cold-breath'));
  ok('canon member still eligible', r2.fired.includes('cold-draft'));
  ok('groupCanon recorded', state.lore_fx.groupCanon.coldspot === 'cold-draft');
}

// --- 6. budget ---------------------------------------------------------------
{
  const tiny = { lore: { budget_pct: 10, scan_depth: 4, entries: [
    { id: 'big', order: 100, constant: true, content: 'x'.repeat(999999) },
    { id: 'small', order: 50, constant: true, content: 'small fact.' },
  ] } };
  const state = { turn: 1, lore_fx: freshLoreFx() };
  const r = scanLore(tiny, [t('user', 'hi')], state, CTX);
  ok('first (highest-order) entry always lands even over budget', r.fired.includes('big'));
  ok('budget skips later entries instead of truncating', !r.fired.includes('small'));
}

// --- 7. scan depth -----------------------------------------------------------
{
  const state = { turn: 1, lore_fx: freshLoreFx() };
  const transcript = [t('user', 'ura is the key'), t('yuki', 'a'), t('yuki', 'b'), t('yuki', 'c'), t('yuki', 'd')];
  const r = scanLore(pack, transcript, state, CTX);
  ok('keyword outside scan_depth window does not fire', !r.fired.includes('ura-knees'));
}

// --- 8. macros ---------------------------------------------------------------
{
  const a = resolveMacros('{{pick:door:red|blue|green}}', 1234);
  const b = resolveMacros('{{pick:door:red|blue|green}}', 1234);
  const c = resolveMacros('{{pick:door:red|blue|green}}', 9999);
  ok('pick is stable per seed', a === b);
  ok('pick options are legal', ['red', 'blue', 'green'].includes(a) && ['red', 'blue', 'green'].includes(c));
  const r = resolveMacros('{{random:x|y}}', 1);
  ok('random picks an option', ['x', 'y'].includes(r));
  ok('time renders HH:MM', /^\d{2}:\d{2}$/.test(resolveMacros('{{time}}', 1)));
  ok('unknown braces untouched (player_moment safe)', resolveMacros('{{player_moment}}', 1) === '{{player_moment}}');
}

// --- 9. rails ----------------------------------------------------------------
{
  const r1 = applyRails(pack, ['okay. i will check the storeroom', 'my hands shaking so bad']);
  ok('rails strip banned opener', r1.bubbles[0] === 'i will check the storeroom');
  ok('rails replace dead fear image', r1.bubbles[1] === 'my jaw tight so bad');
  const r2 = applyRails({ rails: [{ find: '.*', replace: '', flags: 'gs' }] }, ['something']);
  ok('rails never blank the character (all-dead -> originals)', r2.bubbles[0] === 'something');
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
