// bot 的贪吃蛇：书房电脑上的第二款游戏。
//
// 定位：跟棋一样，是"她在屋里能做的事"。规则是最朴素的贪吃蛇 ——
// 撞墙/撞自己就结束，吃到就长一节；一步一步走（工具调用一次走一步或几步），
// 结束时报一次分数，记进「最高三次」。
//
// 为什么坚持纯函数 + JSON：棋那套已经证明这样最好排错 —— 页面、状态栏、分数
// 全部从同一份 state/snake.json 派生，不会出现"页面显示 12 分、聊天里说 9 分"。

import fs from 'node:fs'
import { env } from './env.mjs'
import { VERSION } from './version.mjs'
import path from 'node:path'


export const SNAKE_FILE = path.join(env().root, 'state', 'snake.json')
// 页面文件名跟着 bot 的名字走
export const snakePage = () => path.join(env().workspace, 'exports', env().petFile('贪吃蛇'))

export const W = 20
export const H = 14
const DIRS = { u: { x: 0, y: -1 }, d: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } }
const OPPOSITE = { u: 'd', d: 'u', l: 'r', r: 'l' }

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0))

export function newGame(now = Date.now()) {
  const cx = Math.floor(W / 2)
  const cy = Math.floor(H / 2)
  return {
    w: W,
    h: H,
    snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }],
    dir: 'r',
    food: { x: cx + 3, y: cy },
    score: 0,
    steps: 0,
    status: 'playing',
    startedAt: now,
    updatedAt: now,
    resultRecorded: false
  }
}

export function normalizeSnake(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const w = clampInt(g.w, 6, 40) || W
  const h = clampInt(g.h, 6, 30) || H
  const snake = Array.isArray(g.snake) && g.snake.length
    ? g.snake.filter((c) => c && Number.isInteger(c.x) && Number.isInteger(c.y)).map((c) => ({ x: c.x, y: c.y }))
    : newGame().snake
  const food = g.food && Number.isInteger(g.food.x) ? { x: g.food.x, y: g.food.y } : { x: 0, y: 0 }
  return {
    w,
    h,
    snake,
    dir: DIRS[g.dir] ? g.dir : 'r',
    food,
    score: Math.max(0, Number(g.score) || 0),
    steps: Math.max(0, Number(g.steps) || 0),
    status: ['playing', 'over', 'win'].includes(g.status) ? g.status : 'playing',
    startedAt: Number(g.startedAt) || 0,
    updatedAt: Number(g.updatedAt) || 0,
    resultRecorded: g.resultRecorded === true
  }
}

const occupied = (game, x, y) => game.snake.some((c) => c.x === x && c.y === y)

/** 随机找一个空格放食物；棋盘满了就返回 null（算通关）。 */
export function placeFood(game, rng = Math.random) {
  const free = []
  for (let y = 0; y < game.h; y += 1) {
    for (let x = 0; x < game.w; x += 1) {
      if (!occupied(game, x, y)) free.push({ x, y })
    }
  }
  if (!free.length) return null
  return free[Math.floor(rng() * free.length) % free.length]
}

/**
 * 走一步。返回新状态：
 *   ok=false: 方向写错了 / 游戏已结束
 *   over: 撞墙或撞自己（分数不再变）
 */
export function step(game, rawDir, rng = Math.random, now = Date.now()) {
  const g = normalizeSnake(game)
  if (g.status !== 'playing') return { ok: false, error: '这一局已经结束了，开新的用 qq_snake_new' }
  const dir = String(rawDir || '').trim().toLowerCase()
  const key = { u: 'u', up: 'u', '上': 'u', d: 'd', down: 'd', '下': 'd', l: 'l', left: 'l', '左': 'l', r: 'r', right: 'r', '右': 'r' }[dir]
  if (!key) return { ok: false, error: `方向要写 u/d/l/r（上/下/左/右），收到「${rawDir}」` }
  if (g.snake.length > 1 && OPPOSITE[key] === g.dir) return { ok: false, error: '不能直接掉头（会撞到自己）' }
  const delta = DIRS[key]
  const head = { x: g.snake[0].x + delta.x, y: g.snake[0].y + delta.y }
  const hitsWall = head.x < 0 || head.x >= g.w || head.y < 0 || head.y >= g.h
  // 尾巴这一格会在这一步腾出来，所以撞尾巴不算死（经典规则）
  const tail = g.snake[g.snake.length - 1]
  const eating = g.food && head.x === g.food.x && head.y === g.food.y
  const body = g.snake.slice(0, eating ? g.snake.length : g.snake.length - 1)
  const hitsSelf = body.some((c) => c.x === head.x && c.y === head.y)
  if (hitsWall || hitsSelf) {
    const next = { ...g, dir: key, steps: g.steps + 1, status: 'over', updatedAt: now }
    return { ok: true, game: next, over: true, reason: hitsWall ? '撞墙了' : '拐进自己身上了' }
  }
  const snake = [head, ...g.snake]
  if (!eating) snake.pop()
  const next = { ...g, snake, dir: key, steps: g.steps + 1, updatedAt: now }
  if (eating) {
    next.score = g.score + 1
    next.food = placeFood(next, rng)
    if (!next.food) { next.status = 'win'; return { ok: true, game: next, over: true, reason: '棋盘被占满了' } }
  }
  return { ok: true, game: next, over: false, eating }
}

/** 连续走几步（同一方向）；吃到东西会记进 events，撞了就提前停。 */
export function stepMany(game, dir, count = 1, rng = Math.random, now = Date.now()) {
  let g = normalizeSnake(game)
  const n = clampInt(count, 1, 20)
  const events = []
  for (let i = 0; i < n; i += 1) {
    const r = step(g, dir, rng, now)
    if (!r.ok) return { ok: false, error: r.error, game: g, events }
    g = r.game
    if (r.eating) events.push('吃到东西')
    if (r.over) return { ok: true, game: g, over: true, reason: r.reason, events }
  }
  return { ok: true, game: g, over: false, events }
}

export function renderBoard(game) {
  const g = normalizeSnake(game)
  const rows = []
  for (let y = 0; y < g.h; y += 1) {
    let line = ''
    for (let x = 0; x < g.w; x += 1) {
      const isHead = g.snake[0]?.x === x && g.snake[0]?.y === y
      const isBody = g.snake.some((c) => c.x === x && c.y === y)
      const isFood = g.food && g.food.x === x && g.food.y === y
      line += isHead ? '🐍' : isFood ? '🍎' : isBody ? '▪' : '·'
    }
    rows.push(line)
  }
  return rows.join('\n')
}

export function gameSummary(game, extra = {}) {
  const g = normalizeSnake(game)
  return {
    状态: g.status === 'over' ? '结束' : g.status === 'win' ? '通关' : '进行中',
    分数: g.score,
    长度: g.snake.length,
    步数: g.steps,
    board: renderBoard(g),
    ...extra
  }
}

export function loadSnake() {
  try {
    return normalizeSnake(JSON.parse(fs.readFileSync(SNAKE_FILE, 'utf8')))
  } catch {
    return null
  }
}

export function saveSnake(game) {
  const data = normalizeSnake({ ...game, updatedAt: Date.now() })
  fs.mkdirSync(path.dirname(SNAKE_FILE), { recursive: true })
  const tmp = SNAKE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, SNAKE_FILE)
  return data
}

export function renderPage(game, best = []) {
  const g = normalizeSnake(game)
  const cells = []
  for (let y = 0; y < g.h; y += 1) {
    for (let x = 0; x < g.w; x += 1) {
      const isHead = g.snake[0]?.x === x && g.snake[0]?.y === y
      const isBody = g.snake.some((c) => c.x === x && c.y === y)
      const isFood = g.food && g.food.x === x && g.food.y === y
      const cls = isHead ? 'head' : isFood ? 'food' : isBody ? 'body' : ''
      cells.push(`<div class="cell ${cls}">${isFood ? '🍎' : ''}</div>`)
    }
  }
  const bestList = (best || []).slice(0, 3).map((b, i) => `<li>${['🥇', '🥈', '🥉'][i]} ${Number(b.score) || 0} 分<span>${b.at ? new Date(b.at).toLocaleString('zh-CN', { hour12: false }) : ''}</span></li>`).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${env().petTitle('贪吃蛇')}</title>
<style>
  :root { --bg:#14110f; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; --line:#332b25; }
  * { box-sizing:border-box; }
  body { margin:0; padding:36px 18px 56px; background:radial-gradient(900px 480px at 50% -10%, #221a13 0%, var(--bg) 62%); color:var(--ink); font:15px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  header { max-width:760px; margin:0 auto 16px; }
  h1 { margin:0 0 4px; font-size:24px; letter-spacing:2px; font-weight:600; }
  .sub { color:var(--muted); font-size:13px; }
  .sub b { color:var(--accent); font-weight:500; }
  .board { width:min(720px,94vw); margin:14px auto; display:grid; grid-template-columns:repeat(${g.w}, 1fr); gap:2px; background:#241d18; padding:8px; border-radius:12px; border:1px solid var(--line); }
  .cell { aspect-ratio:1/1; background:#1b1714; border-radius:3px; display:flex; align-items:center; justify-content:center; font-size:80%; }
  .cell.body { background:#4f7a4a; }
  .cell.head { background:#8fd18a; box-shadow:0 0 8px rgba(143,209,138,.55); }
  .cell.food { background:#2a231d; }
  .info { max-width:720px; margin:8px auto; color:var(--muted); font-size:13px; display:flex; gap:18px; flex-wrap:wrap; align-items:baseline; }
  .info b { color:var(--ink); font-weight:500; }
  .best { max-width:720px; margin:18px auto; }
  .best h2 { font-size:14px; font-weight:500; color:#cbbca8; margin:0 0 8px; letter-spacing:1px; }
  .best ul { list-style:none; padding:0; margin:0; display:grid; gap:6px; }
  .best li { background:#1d1916; border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:13px; display:flex; justify-content:space-between; color:#d9c9b4; }
  .best li span { color:#6f6357; font-size:11.5px; }
</style></head>
<body>
<header>
  <h1>${env().petTitle('贪吃蛇')}</h1>
  <div class="sub">书房电脑上的小游戏 · ${g.status === 'over' ? '结束' : g.status === 'win' ? '通关' : '进行中'} · 分数 <b>${g.score}</b> · 长度 ${g.snake.length} · ${g.steps} 步</div>
</header>
<div class="board">${cells.join('')}</div>
<div class="info"><span>方向键由她自己决定（工具里写 u/d/l/r）</span><span>棋盘 ${g.w}×${g.h}</span></div>
<div class="best"><h2>最高三次</h2><ul>${bestList || '<li>还没有分数</li>'}</ul></div>
<div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body></html>`
}

export function writePage(game, best = []) {
  const file = snakePage()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, renderPage(game, best), 'utf8')
  return file
}
