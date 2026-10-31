// bot 的五子棋：跟主人下（没有人机），棋盘 15×15。
//
// 规则就是普通五子棋：黑先、轮流落子、先连成五子（及以上）赢。
//
// 特殊技能「天下劫」：
//   · 按一下 = 武装；**下一颗**落子时，周围 8 格里会直接补出至多 4 颗同色棋子。
//     补充的棋子也能凑成五连（这就是它的用法：突然长出半片棋）。
//   · 初始冷却：先手（黑）第 4 手之后才能用，后手（白）第 3 手之后。
//   · 用掉之后要等 **3 手**（自己的落子数）才能再用。
//   · 一局每方最多用 **2 次**。
//
// 数据只有一份 state/gomoku.json：网页（主人在下）和 MCP 工具（bot 在下）都读写它。

import fs from 'node:fs'
import { env } from './env.mjs'
import { VERSION } from './version.mjs'
import path from 'node:path'


export const GOMOKU_FILE = path.join(env().root, 'state', 'gomoku.json')
// 页面文件名跟着 bot 的名字走
export const gomokuPage = () => path.join(env().workspace, 'exports', env().petFile('五子棋'))

export const SIZE = 15
export const BLACK = 1
export const WHITE = 2
const COLS = 'ABCDEFGHIJKLMNO'
const SKILL_INITIAL = { [BLACK]: 4, [WHITE]: 3 }
const SKILL_RECHARGE = 3
const SKILL_USES = 2

const sideName = (s) => (s === BLACK ? '黑方（先手）' : '白方（后手）')
const colorLabel = (s) => (s === BLACK ? '黑' : '白')
const stoneChar = (v) => (v === BLACK ? '●' : v === WHITE ? '○' : '·')
const otherSide = (s) => (s === BLACK ? WHITE : BLACK)

/** 随机分边：主人执黑还是执白由电脑定（rng 可注入，测试用）。 */
export function assignSides(rng = Math.random) {
  const owner = rng() < 0.5 ? BLACK : WHITE
  return { owner, whale: otherSide(owner) }
}

export function newGame(now = Date.now(), rng = Math.random) {
  const sides = assignSides(rng)
  return {
    size: SIZE,
    board: new Array(SIZE * SIZE).fill(0),
    turn: BLACK,
    // 先在大厅里：双方都按"准备"、主人再点"开始"，才真正开局
    status: 'lobby',
    sides,
    ready: { owner: false, whale: false },
    resultRecorded: false,
    moves: [],
    counts: { [BLACK]: 0, [WHITE]: 0 },
    skill: {
      [BLACK]: { usesLeft: SKILL_USES, readyAfterMoves: SKILL_INITIAL[BLACK], armed: false, usedAt: [] },
      [WHITE]: { usesLeft: SKILL_USES, readyAfterMoves: SKILL_INITIAL[WHITE], armed: false, usedAt: [] }
    },
    startedAt: now,
    updatedAt: now
  }
}

export function normalizeGomoku(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const size = Number(g.size) === SIZE ? SIZE : SIZE
  const board = Array.isArray(g.board) && g.board.length === size * size
    ? g.board.map((v) => (v === BLACK || v === WHITE ? v : 0))
    : new Array(size * size).fill(0)
  const skill = {}
  for (const side of [BLACK, WHITE]) {
    const s = g.skill?.[side] || {}
    skill[side] = {
      usesLeft: Math.max(0, Math.min(SKILL_USES, Number.isFinite(Number(s.usesLeft)) ? Number(s.usesLeft) : SKILL_USES)),
      readyAfterMoves: Math.max(0, Number(s.readyAfterMoves) || 0),
      armed: s.armed === true,
      usedAt: Array.isArray(s.usedAt) ? s.usedAt.map(Number).filter(Number.isFinite).slice(-SKILL_USES) : []
    }
  }
  const sidesRaw = g.sides && typeof g.sides === 'object' ? g.sides : {}
  const validSides = sidesRaw.owner === BLACK || sidesRaw.owner === WHITE
  const sides = validSides ? { owner: sidesRaw.owner, whale: otherSide(sidesRaw.owner) } : { owner: BLACK, whale: WHITE }
  return {
    size,
    board,
    turn: g.turn === WHITE ? WHITE : BLACK,
    status: ['lobby', 'playing', 'black_win', 'white_win', 'draw'].includes(g.status) ? g.status : 'lobby',
    sides,
    ready: { owner: g.ready?.owner === true, whale: g.ready?.whale === true },
    resultRecorded: g.resultRecorded === true,
    moves: Array.isArray(g.moves) ? g.moves.slice(-400) : [],
    counts: { [BLACK]: Math.max(0, Number(g.counts?.[BLACK]) || 0), [WHITE]: Math.max(0, Number(g.counts?.[WHITE]) || 0) },
    skill,
    startedAt: Number(g.startedAt) || 0,
    updatedAt: Number(g.updatedAt) || 0
  }
}

const idx = (x, y) => y * SIZE + x
const inBoard = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE

export function cellName(x, y) {
  return `${COLS[x] || '?'}${y + 1}`
}

export function parseCell(raw) {
  const m = /^([a-oA-O])\s*([1-9]|1[0-5])$/.exec(String(raw || '').trim())
  if (!m) return null
  return { x: COLS.indexOf(m[1].toUpperCase()), y: Number(m[2]) - 1 }
}

/** 某点落下后是否连成五子（横竖两条斜线各查一次，正反方向都算）。 */
export function isWinningMove(board, x, y, side) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dx, dy] of dirs) {
    let n = 1
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (inBoard(cx, cy) && board[idx(cx, cy)] === side) {
        n += 1
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (n >= 5) return true
  }
  return false
}

/** 天下劫：周围 8 格里补出至多 4 颗同色棋子（优先随机，返回补了哪些格）。 */
export function applySkillBurst(g, x, y, side, rng = Math.random) {
  const empty = []
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue
      const nx = x + dx
      const ny = y + dy
      if (inBoard(nx, ny) && g.board[idx(nx, ny)] === 0) empty.push({ x: nx, y: ny })
    }
  }
  // 洗一下再取 4 个（用 rng 保证测试可复现）
  for (let i = empty.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [empty[i], empty[j]] = [empty[j], empty[i]]
  }
  const picked = empty.slice(0, 4)
  for (const p of picked) g.board[idx(p.x, p.y)] = side
  return picked
}

export function canUseSkill(g, side) {
  const s = g.skill[side]
  if (g.status === 'lobby') return { ok: false, reason: '还没开始（等双方都准备、主人点开始）' }
  if (g.status !== 'playing') return { ok: false, reason: '这局已经结束了' }
  if (g.turn !== side) return { ok: false, reason: '还没轮到你' }
  if (s.armed) return { ok: false, reason: '天下劫已经准备好了，下一手就触发' }
  if (s.usesLeft <= 0) return { ok: false, reason: '这局已经用满 2 次了' }
  if (g.counts[side] < s.readyAfterMoves) {
    return { ok: false, reason: `还差 ${s.readyAfterMoves - g.counts[side]} 手冷却（第 ${s.readyAfterMoves + 1} 手起可用）` }
  }
  return { ok: true }
}

/** 按准备（who = 'owner' | 'whale'）。准备不可撤销，两边都按了就能开始。 */
export function readyUp(g, who, now = Date.now()) {
  const game = normalizeGomoku(g)
  if (game.status !== 'lobby') return { ok: false, error: '这局已经开始了' }
  if (who !== 'owner' && who !== 'whale') return { ok: false, error: 'who 只能是 owner / whale' }
  if (game.ready[who]) return { ok: false, error: who === 'owner' ? '你已经准备过了' : `${env().petName()}已经准备好了` }
  game.ready[who] = true
  game.updatedAt = now
  const both = game.ready.owner && game.ready.whale
  return {
    ok: true,
    game,
    message: who === 'owner' ? '你准备好了' : `${env().petName()}准备好了`,
    next: both ? '双方都准备好了：点「开始」' : '还在等另一边准备'
  }
}

export function canStart(g) {
  return g.status === 'lobby' && g.ready.owner && g.ready.whale
}

/** 开始：双方都准备之后，主人点开始，黑先。 */
export function startGame(g, now = Date.now()) {
  const game = normalizeGomoku(g)
  if (game.status !== 'lobby') return { ok: false, error: '这局已经开始了' }
  if (!canStart(game)) return { ok: false, error: '还有人没准备' }
  game.status = 'playing'
  game.turn = BLACK
  game.startedAt = now
  game.updatedAt = now
  return { ok: true, game, message: `开始！黑先 · 你执${colorLabel(game.sides.owner)}` }
}

export function armSkill(g, side, now = Date.now()) {
  const g2 = normalizeGomoku(g)
  const can = canUseSkill(g2, side)
  if (!can.ok) return { ok: false, error: can.reason }
  g2.skill[side].armed = true
  g2.skill[side].usesLeft -= 1
  g2.updatedAt = now
  return { ok: true, game: g2, message: `${sideName(side)} 开了天下劫：下一颗落子时，周围会补出至多四颗同色棋子` }
}

/** 落子。side 必须等于当前轮次；落子后若处于天下劫状态就炸开。 */
export function place(g, x, y, side, rng = Math.random, now = Date.now()) {
  const game = normalizeGomoku(g)
  if (game.status === 'lobby') return { ok: false, error: '还没开始：等双方都准备，主人点「开始」' }
  if (game.status !== 'playing') return { ok: false, error: '这局已经结束了，开新的吧' }
  if (side !== game.turn) return { ok: false, error: `现在轮到${sideName(game.turn)}` }
  if (!inBoard(x, y)) return { ok: false, error: `坐标越界：${x},${y}` }
  if (game.board[idx(x, y)] !== 0) return { ok: false, error: `${cellName(x, y)} 已经有子了` }
  game.board[idx(x, y)] = side
  game.counts[side] += 1
  game.moves.push({ x, y, side, at: now })
  const burst = game.skill[side].armed ? applySkillBurst(game, x, y, side, rng) : []
  let message = `${sideName(side)} 落在 ${cellName(x, y)}`
  if (burst.length) {
    game.skill[side].armed = false
    game.skill[side].usedAt.push(now)
    game.skill[side].readyAfterMoves = game.counts[side] + SKILL_RECHARGE
    message += `，天下劫炸开：${burst.map((p) => cellName(p.x, p.y)).join('、')} 补出同色棋子`
  }
  // 胜负：先看这手，再看炸出来的棋子有没有凑成五连
  const winCells = [{ x, y }, ...burst]
  const win = winCells.some((p) => isWinningMove(game.board, p.x, p.y, side))
  if (win) {
    game.status = side === BLACK ? 'black_win' : 'white_win'
    game.turn = game.turn === BLACK ? WHITE : BLACK
  } else if (game.board.every((v) => v !== 0)) {
    game.status = 'draw'
  } else {
    game.turn = game.turn === BLACK ? WHITE : BLACK
  }
  game.updatedAt = now
  return { ok: true, game, burst, message, win: Boolean(win) }
}

export function statusText(g) {
  if (g.status === 'lobby') {
    if (g.ready.owner && g.ready.whale) return '双方都准备好了，等主人点「开始」'
    if (g.ready.owner) return `你准备好了，等${env().petName()}`
    if (g.ready.whale) return `${env().petName()}准备好了，等你`
    return '等双方准备'
  }
  if (g.status === 'black_win') return '黑方赢了'
  if (g.status === 'white_win') return '白方赢了'
  if (g.status === 'draw') return '和棋（棋盘满了）'
  return `轮到${sideName(g.turn)}`
}

/** 这一方是不是"主人"（用来把颜色翻译成"你/bot"）。 */
export function sideOwnerOf(g, side) {
  return g.sides.owner === side ? '你' : env().petName()
}

/**
 * 这一局对 **bot** 来说是什么结果：'win' | 'loss' | 'draw' | null（没结束）。
 * 用于把战绩记进 home-life。
 */
export function whaleResult(g) {
  if (g.status === 'black_win') return g.sides.whale === BLACK ? 'win' : 'loss'
  if (g.status === 'white_win') return g.sides.whale === WHITE ? 'win' : 'loss'
  if (g.status === 'draw') return 'draw'
  return null
}

/** 对主人来说是什么结果（网页那边显示用）。 */
export function ownerResult(g) {
  const w = whaleResult(g)
  if (!w) return null
  if (w === 'draw') return 'draw'
  return w === 'win' ? 'loss' : 'win'
}

export function skillStatus(g, side) {
  const s = g.skill[side]
  if (s.usesLeft <= 0) return '用完了'
  if (s.armed) return '已准备好（下一手触发）'
  if (g.counts[side] < s.readyAfterMoves) return `冷却中（还差 ${s.readyAfterMoves - g.counts[side]} 手）`
  return `可用（剩 ${s.usesLeft} 次）`
}

export function renderBoard(g) {
  const rows = []
  let head = '    '
  for (let x = 0; x < SIZE; x += 1) head += `${COLS[x]} `
  rows.push(head)
  for (let y = 0; y < SIZE; y += 1) {
    let line = `${String(y + 1).padStart(2)}  `
    for (let x = 0; x < SIZE; x += 1) line += `${stoneChar(g.board[idx(x, y)])} `
    rows.push(line)
  }
  return rows.join('\n')
}

export function summary(g) {
  const owner = g.sides.owner
  return {
    局面: statusText(g),
    你执: colorLabel(owner),
    [`${env().petName()}执`]: colorLabel(otherSide(owner)),
    准备: `你${g.ready.owner ? '已准备' : '未准备'} · ${env().petName()}${g.ready.whale ? '已准备' : '未准备'}`,
    轮次: g.turn === owner ? '你' : env().petName(),
    天下劫: { [colorLabel(BLACK)]: skillStatus(g, BLACK), [colorLabel(WHITE)]: skillStatus(g, WHITE) },
    board: renderBoard(g)
  }
}

export function loadGomoku() {
  try {
    return normalizeGomoku(JSON.parse(fs.readFileSync(GOMOKU_FILE, 'utf8')))
  } catch {
    return null
  }
}

export function saveGomoku(game) {
  const data = normalizeGomoku({ ...game, updatedAt: Date.now() })
  fs.mkdirSync(path.dirname(GOMOKU_FILE), { recursive: true })
  const tmp = GOMOKU_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, GOMOKU_FILE)
  return data
}

export function loadOrCreate() {
  return loadGomoku() || saveGomoku(newGame())
}

export function renderPage(g) {
  const cells = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const v = g.board[idx(x, y)]
      const last = g.moves.length ? g.moves[g.moves.length - 1] : null
      const isLast = last && last.x === x && last.y === y
      cells.push(`<button class="cell${v === BLACK ? ' black' : v === WHITE ? ' white' : ''}${isLast ? ' last' : ''}" data-x="${x}" data-y="${y}" aria-label="${cellName(x, y)}">${isLast ? '<i></i>' : ''}</button>`)
    }
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${env().petTitle('五子棋')}</title>
<style>
  :root { --bg:#14110f; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; --line:#332b25; --wood:#c9a878; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 16px 56px; background:radial-gradient(900px 480px at 50% -10%, #221a13 0%, var(--bg) 62%); color:var(--ink); font:15px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  header { max-width:760px; margin:0 auto 12px; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { margin:0; font-size:24px; letter-spacing:2px; font-weight:600; }
  .status { color:var(--muted); font-size:13px; }
  .status b { color:var(--accent); font-weight:500; }
  .wrap { max-width:760px; margin:0 auto; }
  .board { display:grid; grid-template-columns:repeat(${SIZE}, 1fr); background:var(--wood); border-radius:10px; padding:8px; gap:0; box-shadow:0 14px 40px rgba(0,0,0,.4); }
  .board.lobby { opacity:.55; }
  .cell { position:relative; aspect-ratio:1/1; border:1px solid rgba(60,40,20,.35); background:transparent; cursor:pointer; padding:0; }
  .cell::after { content:''; position:absolute; inset:18%; border-radius:50%; background:transparent; }
  .cell.black::after { background:radial-gradient(circle at 35% 30%, #6b6b6b, #111 70%); }
  .cell.white::after { background:radial-gradient(circle at 35% 30%, #fff, #c9c9c9 70%); }
  .cell.last::before { content:''; position:absolute; inset:38%; border-radius:50%; background:var(--accent); z-index:2; }
  .cell:hover::after { background:rgba(0,0,0,.18); }
  .cell.black:hover::after, .cell.white:hover::after { background:inherit; }
  .toolbar { max-width:760px; margin:14px auto 0; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button.act { background:var(--accent); color:#1a140e; border:0; border-radius:10px; padding:9px 16px; font:inherit; font-weight:500; cursor:pointer; }
  button.act:disabled { opacity:.45; cursor:default; }
  button.start { background:#8fd18a; color:#12210f; }
  button.ghost { background:#2a231d; color:#d9c9b4; border:1px solid #3a3129; border-radius:10px; padding:9px 14px; font:inherit; cursor:pointer; }
  button[hidden] { display:none; }
  .panel { background:#1d1916; border:1px solid var(--line); border-radius:12px; padding:12px 14px; color:var(--muted); font-size:13px; }
  .panel b { color:var(--ink); font-weight:500; }
  .hint { min-height:18px; color:#c9a877; font-size:12.5px; margin-top:6px; }
  .hint.err { color:#e08a7a; }
</style></head>
<body>
<header>
  <h1>${env().petTitle('五子棋')}</h1>
  <div class="status" id="status">${statusText(g)}</div>
</header>
<div class="wrap">
  <div class="board${g.status === 'lobby' ? ' lobby' : ''}" id="board">${cells.join('')}</div>
  <div class="toolbar">
    <button class="act" id="ready" ${g.status === 'lobby' && !g.ready.owner ? '' : 'disabled'}>准备</button>
    <button class="act start" id="start" ${canStart(g) ? '' : 'hidden'}>开始</button>
    <button class="act" id="skill" ${canUseSkill(g, g.sides.owner).ok ? '' : 'disabled'}>天下劫</button>
    <button class="ghost" id="newgame">新开一局</button>
    <div class="panel">你执 <b id="sideColor">${colorLabel(g.sides.owner)}</b> · 天下劫：<span id="skillState">${skillStatus(g, g.sides.owner)}</span></div>
  </div>
  <div class="hint" id="hint"></div>
  <div class="hint" style="color:#6f6357">${env().petName()}在对话里准备/落子；每次动作后这一页会重画。</div>
</div>
<script>
(() => {
  const KEY = 'qq-console-token';
  const q = new URLSearchParams(location.search);
  if (q.get('token')) localStorage.setItem(KEY, q.get('token'));
  const token = q.get('token') || localStorage.getItem(KEY) || '';
  if (q.get('token')) history.replaceState(null, '', location.pathname);
  const $ = (id) => document.getElementById(id);
  const hint = (t, err) => { $('hint').textContent = t || ''; $('hint').className = 'hint' + (err ? ' err' : ''); };
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-console-token': token, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  };
  const paint = (v) => {
    const board = $('board');
    const last = v.moves && v.moves.length ? v.moves[v.moves.length - 1] : null;
    board.className = 'board' + (v.phase === 'lobby' ? ' lobby' : '');
    [...board.children].forEach((el, i) => {
      const x = i % ${SIZE}, y = Math.floor(i / ${SIZE});
      const val = v.board[y * ${SIZE} + x];
      el.className = 'cell' + (val === 1 ? ' black' : val === 2 ? ' white' : '') + (last && last.x === x && last.y === y ? ' last' : '');
      el.innerHTML = last && last.x === x && last.y === y ? '<i></i>' : '';
    });
    $('status').textContent = v.statusText;
    $('sideColor').textContent = v.ownerSide;
    $('skillState').textContent = v.skillMine;
    const ready = $('ready');
    ready.hidden = v.phase !== 'lobby' || v.ownerReady;
    ready.disabled = false;
    $('start').hidden = !v.canStart;
    $('start').disabled = !v.canStart;
    $('skill').hidden = v.phase !== 'playing';
    $('skill').disabled = !v.canSkill;
  };
  const load = async () => { const r = await api('/api/gomoku'); paint(r.view); };
  document.addEventListener('click', async (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    if ($('board').classList.contains('lobby')) { hint('还没开始：先准备，等双方都准备好再点「开始」', true); return; }
    try {
      const x = Number(cell.dataset.x), y = Number(cell.dataset.y);
      const r = await api('/api/gomoku/place', { method: 'POST', body: JSON.stringify({ x, y }) });
      paint(r.view);
      hint(r.message || '');
    } catch (err) { hint(err.message, true); }
  });
  $('ready').onclick = async () => {
    try { const r = await api('/api/gomoku/ready', { method: 'POST', body: '{}' }); paint(r.view); hint(r.message || ''); }
    catch (err) { hint(err.message, true); }
  };
  $('start').onclick = async () => {
    try { const r = await api('/api/gomoku/start', { method: 'POST', body: '{}' }); paint(r.view); hint(r.message || ''); }
    catch (err) { hint(err.message, true); }
  };
  $('skill').onclick = async () => {
    try { const r = await api('/api/gomoku/skill', { method: 'POST', body: '{}' }); paint(r.view); hint(r.message || ''); }
    catch (err) { hint(err.message, true); }
  };
  $('newgame').onclick = async () => {
    try { const r = await api('/api/gomoku/new', { method: 'POST', body: '{}' }); paint(r.view); hint('新开一局（重新随机分边）'); }
    catch (err) { hint(err.message, true); }
  };
  load().catch((e) => hint(e.message, true));
  setInterval(() => { load().catch(() => {}); }, 2000);
})();
</script>
<div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body></html>`
}

/** 页面/接口用的视图：把状态摊平成几个字段。 */
export function viewOf(g) {
  const owner = g.sides.owner
  const phase = g.status === 'lobby' ? 'lobby' : g.status === 'playing' ? 'playing' : 'over'
  return {
    status: g.status,
    phase,
    statusText: statusText(g),
    ownerSide: colorLabel(owner),
    whaleSide: colorLabel(g.sides.whale),
    ownerReady: g.ready.owner,
    whaleReady: g.ready.whale,
    canStart: canStart(g),
    yourTurn: g.status === 'playing' && g.turn === owner,
    canSkill: canUseSkill(g, owner).ok,
    skillMine: skillStatus(g, owner),
    skillTheirs: skillStatus(g, g.sides.whale),
    board: g.board,
    moves: g.moves.slice(-20)
  }
}

export function writePage(g) {
  const file = gomokuPage()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, renderPage(g), 'utf8')
  return file
}
