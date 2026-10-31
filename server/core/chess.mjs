// bot 的棋：一个**能真下**的小棋引擎（不依赖任何外部库）。
//
// 定位：书房那台电脑上的"人机对弈"。电脑这方很朴素 —— 会吃子、会看一步回敬，
// 不做开局库、不算太深（深 2 层 + 吃子优先），但它**走的是合法棋**：
// 将军、将死、逼和、吃过路兵、王车易位、升变都认。
//
// 三个取舍：
//   1) 棋盘用 64 格数组（a8 = 0 … h1 = 63），纯字符串状态，方便直接存 JSON、也方便渲染。
//   2) 走子用 UCI（`e2e4`、`e7e8q`）；给模型看的时候同时给"合法走法列表"，
//      它要是走了不合法的一步，就把合法列表回给它，而不是让它猜。
//   3) 电脑只往前算 2 层（自己一步 + 对方一步），但**永远不会走出送王的棋**（合法性过滤）。
//      真接 Stockfish 另说 —— 这一版要的是"能陪着下"，不是"下得好"。
//
// 纯函数 + 一个 JSON 文件；页面（exports/<名字>的棋局.html）每次落子后重画。

import fs from 'node:fs'
import { env } from './env.mjs'
import { VERSION } from './version.mjs'
import path from 'node:path'


export const GAME_FILE = path.join(env().root, 'state', 'chess.json')
// 页面文件名跟着 bot 的名字走
export const boardPage = () => path.join(env().workspace, 'exports', env().petFile('棋局'))

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'

const FILES = 'abcdefgh'
const UNICODE = { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔', p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
const VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 }

const colorOf = (p) => (p === '.' ? null : p === p.toUpperCase() ? 'w' : 'b')
const other = (c) => (c === 'w' ? 'b' : 'w')
const fileOf = (i) => i % 8
const rankOf = (i) => Math.floor(i / 8)
const idxOf = (r, f) => r * 8 + f
const onBoard = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8
const squareName = (i) => FILES[fileOf(i)] + (8 - rankOf(i))
const parseSquare = (s) => {
  const m = /^([a-h])([1-8])$/.exec(String(s || '').toLowerCase())
  if (!m) return null
  return idxOf(8 - Number(m[2]), FILES.indexOf(m[1]))
}

export function parseFen(fen) {
  const [boardPart, turnPart, castlePart, epPart, halfPart] = String(fen || START_FEN).trim().split(/\s+/)
  const board = new Array(64).fill('.')
  let i = 0
  for (const ch of boardPart) {
    if (ch === '/') continue
    if (/\d/.test(ch)) { i += Number(ch); continue }
    board[i++] = ch
  }
  return {
    board,
    turn: turnPart === 'b' ? 'b' : 'w',
    castling: {
      wk: castlePart.includes('K'), wq: castlePart.includes('Q'),
      bk: castlePart.includes('k'), bq: castlePart.includes('q')
    },
    ep: epPart && epPart !== '-' ? parseSquare(epPart) : null,
    halfmove: Number(halfPart) || 0
  }
}

/** 只用于"重新开始"：全新的棋盘。 */
export function newGame() {
  return normalizeGame({ ...parseFen(START_FEN), moves: [], status: 'playing', aiSide: 'b', startedAt: Date.now() })
}

export function normalizeGame(raw) {
  const base = parseFen(START_FEN)
  const g = raw && typeof raw === 'object' ? raw : {}
  const board = Array.isArray(g.board) && g.board.length === 64 ? g.board.map((p) => (typeof p === 'string' && p.length === 1 ? p : '.')) : base.board
  const c = g.castling && typeof g.castling === 'object' ? g.castling : base.castling
  const ep = Number.isInteger(g.ep) && g.ep >= 0 && g.ep < 64 ? g.ep : null
  return {
    board,
    turn: g.turn === 'b' ? 'b' : 'w',
    castling: { wk: c.wk === true, wq: c.wq === true, bk: c.bk === true, bq: c.bq === true },
    ep,
    halfmove: Number(g.halfmove) || 0,
    log: [],
    moves: Array.isArray(g.moves) ? g.moves.slice(-200) : [],
    status: ['playing', 'checkmate', 'stalemate', 'draw', 'resigned'].includes(g.status) ? g.status : 'playing',
    aiSide: g.aiSide === 'w' ? 'w' : 'b',
    resultRecorded: g.resultRecorded === true,
    startedAt: Number(g.startedAt) || 0,
    updatedAt: Number(g.updatedAt) || 0
  }
}

// ── 攻击判定 ────────────────────────────────────────────────────────────────
const KNIGHT_DELTAS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
const KING_DELTAS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]

export function isAttacked(board, sq, by) {
  const r = rankOf(sq)
  const f = fileOf(sq)
  // 兵：白兵在 sq 下面（r+1 行）斜着攻上来
  const pawnRow = by === 'w' ? r + 1 : r - 1
  const pawn = by === 'w' ? 'P' : 'p'
  for (const df of [-1, 1]) {
    if (onBoard(pawnRow, f + df) && board[idxOf(pawnRow, f + df)] === pawn) return true
  }
  const knight = by === 'w' ? 'N' : 'n'
  for (const [dr, df] of KNIGHT_DELTAS) {
    if (onBoard(r + dr, f + df) && board[idxOf(r + dr, f + df)] === knight) return true
  }
  const king = by === 'w' ? 'K' : 'k'
  for (const [dr, df] of KING_DELTAS) {
    if (onBoard(r + dr, f + df) && board[idxOf(r + dr, f + df)] === king) return true
  }
  const rook = by === 'w' ? 'R' : 'r'
  const bishop = by === 'w' ? 'B' : 'b'
  const queen = by === 'w' ? 'Q' : 'q'
  const slide = (dr, df, pieces) => {
    let rr = r + dr
    let ff = f + df
    while (onBoard(rr, ff)) {
      const p = board[idxOf(rr, ff)]
      if (p !== '.') return pieces.includes(p)
      rr += dr
      ff += df
    }
    return false
  }
  if (slide(-1, 0, [rook, queen]) || slide(1, 0, [rook, queen]) || slide(0, -1, [rook, queen]) || slide(0, 1, [rook, queen])) return true
  if (slide(-1, -1, [bishop, queen]) || slide(-1, 1, [bishop, queen]) || slide(1, -1, [bishop, queen]) || slide(1, 1, [bishop, queen])) return true
  return false
}

function kingSquare(board, color) {
  const k = color === 'w' ? 'K' : 'k'
  const i = board.indexOf(k)
  return i >= 0 ? i : -1
}

export function inCheck(pos, color = pos.turn) {
  const k = kingSquare(pos.board, color)
  if (k < 0) return false
  return isAttacked(pos.board, k, other(color))
}

// ── 走法生成 ────────────────────────────────────────────────────────────────
function push(list, move) { list.push(move) }

function pseudoMovesFor(pos, from) {
  const { board } = pos
  const p = board[from]
  const color = colorOf(p)
  if (!color || color !== pos.turn) return []
  const r = rankOf(from)
  const f = fileOf(from)
  const out = []
  const add = (to, extra = {}) => {
    const target = board[to]
    if (target !== '.' && colorOf(target) === color) return false
    push(out, { from, to, ...extra })
    return target === '.'
  }
  const type = p.toUpperCase()

  if (type === 'P') {
    const dir = color === 'w' ? -1 : 1
    const startRow = color === 'w' ? 6 : 1
    const promoRow = color === 'w' ? 0 : 7
    const one = idxOf(r + dir, f)
    if (onBoard(r + dir, f) && board[one] === '.') {
      if (r + dir === promoRow) push(out, { from, to: one, promo: 'q' })
      else push(out, { from, to: one })
      const two = idxOf(r + 2 * dir, f)
      if (r === startRow && board[two] === '.') push(out, { from, to: two, double: true })
    }
    for (const df of [-1, 1]) {
      if (!onBoard(r + dir, f + df)) continue
      const to = idxOf(r + dir, f + df)
      const target = board[to]
      if (target !== '.' && colorOf(target) !== color) {
        if (r + dir === promoRow) push(out, { from, to, promo: 'q' })
        else push(out, { from, to })
      } else if (target === '.' && pos.ep === to) {
        push(out, { from, to, ep: true })
      }
    }
    return out
  }

  if (type === 'N' || type === 'K') {
    const deltas = type === 'N' ? KNIGHT_DELTAS : KING_DELTAS
    for (const [dr, df] of deltas) {
      if (onBoard(r + dr, f + df)) add(idxOf(r + dr, f + df))
    }
    if (type === 'K') {
      // 王车易位：王没动过、车没动过、中间空、王不在被将、经过的格子不被攻
      const rights = pos.castling
      const enemy = other(color)
      const homeRow = color === 'w' ? 7 : 0
      if (r === homeRow && f === 4) {
        const canK = color === 'w' ? rights.wk : rights.bk
        const canQ = color === 'w' ? rights.wq : rights.bq
        if (canK && board[idxOf(homeRow, 5)] === '.' && board[idxOf(homeRow, 6)] === '.') {
          const rookSq = idxOf(homeRow, 7)
          const rook = color === 'w' ? 'R' : 'r'
          if (board[rookSq] === rook && !isAttacked(board, from, enemy) && !isAttacked(board, idxOf(homeRow, 5), enemy) && !isAttacked(board, idxOf(homeRow, 6), enemy)) {
            push(out, { from, to: idxOf(homeRow, 6), castle: 'k' })
          }
        }
        if (canQ && board[idxOf(homeRow, 3)] === '.' && board[idxOf(homeRow, 2)] === '.' && board[idxOf(homeRow, 1)] === '.') {
          const rookSq = idxOf(homeRow, 0)
          const rook = color === 'w' ? 'R' : 'r'
          if (board[rookSq] === rook && !isAttacked(board, from, enemy) && !isAttacked(board, idxOf(homeRow, 3), enemy) && !isAttacked(board, idxOf(homeRow, 2), enemy)) {
            push(out, { from, to: idxOf(homeRow, 2), castle: 'q' })
          }
        }
      }
    }
    return out
  }

  const rays = []
  if (type === 'R' || type === 'Q') rays.push([-1, 0], [1, 0], [0, -1], [0, 1])
  if (type === 'B' || type === 'Q') rays.push([-1, -1], [-1, 1], [1, -1], [1, 1])
  for (const [dr, df] of rays) {
    let rr = r + dr
    let ff = f + df
    while (onBoard(rr, ff)) {
      const to = idxOf(rr, ff)
      const target = board[to]
      if (target === '.') push(out, { from, to })
      else {
        if (colorOf(target) !== color) push(out, { from, to })
        break
      }
      rr += dr
      ff += df
    }
  }
  return out
}

/** 落子（不做合法性检查 —— 合法性由 legalMoves 过滤；这里只管规则变化）。 */
export function applyMove(pos, move) {
  const board = pos.board.slice()
  const p = board[move.from]
  const color = colorOf(p)
  const type = p.toUpperCase()
  board[move.from] = '.'
  if (move.ep) {
    const captured = move.to + (color === 'w' ? 8 : -8)
    board[captured] = '.'
  }
  board[move.to] = move.promo ? (color === 'w' ? move.promo.toUpperCase() : move.promo) : p
  if (move.castle === 'k') {
    const homeRow = color === 'w' ? 7 : 0
    board[idxOf(homeRow, 5)] = board[idxOf(homeRow, 7)]
    board[idxOf(homeRow, 7)] = '.'
  } else if (move.castle === 'q') {
    const homeRow = color === 'w' ? 7 : 0
    board[idxOf(homeRow, 3)] = board[idxOf(homeRow, 0)]
    board[idxOf(homeRow, 0)] = '.'
  }
  const castling = { ...pos.castling }
  if (type === 'K') {
    if (color === 'w') { castling.wk = false; castling.wq = false } else { castling.bk = false; castling.bq = false }
  }
  if (type === 'R') {
    if (move.from === idxOf(7, 0)) castling.wq = false
    if (move.from === idxOf(7, 7)) castling.wk = false
    if (move.from === idxOf(0, 0)) castling.bq = false
    if (move.from === idxOf(0, 7)) castling.bk = false
  }
  const ep = move.double ? (move.from + move.to) / 2 : null
  const captured = pos.board[move.to] !== '.' || move.ep
  return {
    board,
    turn: other(pos.turn),
    castling,
    ep,
    halfmove: type === 'P' || captured ? 0 : pos.halfmove + 1
  }
}

export function legalMoves(pos) {
  const out = []
  for (let i = 0; i < 64; i++) {
    if (!pos.board[i] || colorOf(pos.board[i]) !== pos.turn) continue
    for (const m of pseudoMovesFor(pos, i)) {
      const after = applyMove(pos, m)
      if (!inCheck(after, pos.turn)) out.push(m)
    }
  }
  return out
}

function findLegalMove(pos, from, to, promo) {
  return legalMoves(pos).find((m) => m.from === from && m.to === to && (!m.promo || !promo || m.promo === promo))
}

/** 走一步 UCI（也接受 e2-e4 / e2 e4），返回新状态与棋局结果。 */
export function playMove(game, uci) {
  const g = normalizeGame(game)
  if (g.status !== 'playing') return { ok: false, error: `棋局已经结束（${statusText(g)}），开新局再下` }
  const m = /^([a-h][1-8])[\s-]?([a-h][1-8])([qrbn])?$/i.exec(String(uci || '').trim())
  if (!m) return { ok: false, error: `走法要写成 e2e4 这样（${uci || '空'}）` }
  const from = parseSquare(m[1])
  const to = parseSquare(m[2])
  const promo = m[3] ? m[3].toLowerCase() : null
  if (from === null || to === null) return { ok: false, error: '格子看不懂' }
  const legal = legalMoves(g)
  const move = legal.find((x) => x.from === from && x.to === to && (!x.promo || !promo || x.promo === promo))
  if (!move) {
    return {
      ok: false,
      error: `这步不合法（${squareName(from)}→${squareName(to)}）`,
      legal: legal.map(moveToUci)
    }
  }
  const next = normalizeGame({ ...g, ...applyMove(g, move), moves: [...g.moves, { uci: moveToUci(move), by: g.turn, at: Date.now() }] })
  next.status = statusOf(next)
  next.updatedAt = Date.now()
  return { ok: true, game: next, move: moveToUci(move) }
}

export function moveToUci(m) {
  return squareName(m.from) + squareName(m.to) + (m.promo || '')
}

export function statusOf(g) {
  const pos = { ...g }
  const moves = legalMoves(pos)
  if (moves.length === 0) return inCheck(pos) ? 'checkmate' : 'stalemate'
  if (g.halfmove >= 100) return 'draw'
  return 'playing'
}

/** 认输：直接结束这一局（算她投了）。 */
export function resign(game, now = Date.now()) {
  const g = normalizeGame(game)
  if (g.status !== 'playing') return { ok: false, error: '这局已经结束了，开新的用 qq_chess_new' }
  const her = g.aiSide === 'w' ? 'b' : 'w'
  const next = normalizeGame({ ...g, status: 'resigned', updatedAt: now })
  return { ok: true, game: next, her, winner: g.aiSide }
}

export function statusText(g) {
  if (g.status === 'checkmate') return `将死（${g.turn === 'w' ? '白方' : '黑方'}被将死）`
  if (g.status === 'stalemate') return '逼和（和棋）'
  if (g.status === 'draw') return '和棋（五十步）'
  if (g.status === 'resigned') return '认输了（这局投了）'
  return inCheck(g) ? '将军中' : '进行中'
}

// ── 电脑这一方 ──────────────────────────────────────────────────────────────
function material(board, color) {
  let s = 0
  for (const p of board) {
    if (p === '.' || colorOf(p) !== color) continue
    s += VALUE[p.toUpperCase()] || 0
  }
  return s
}

function evalFor(g, color) {
  // 材料差 + 极小的中心奖励（避免电脑老把子往角上放）；两边对称，negamax 才成立
  let score = material(g.board, color) - material(g.board, other(color))
  const center = (c) => {
    let s = 0
    for (let i = 0; i < 64; i++) {
      const p = g.board[i]
      if (p === '.' || colorOf(p) !== c) continue
      const df = Math.abs(3.5 - fileOf(i))
      const dr = Math.abs(3.5 - rankOf(i))
      s += Math.round((7 - df - dr) * 2)
    }
    return s
  }
  score += center(color) - center(other(color))
  return score
}

function searchBest(g, depth, color) {
  const moves = legalMoves(g).sort((a, b) => {
    const ca = g.board[a.to] !== '.' || a.ep ? 1 : 0
    const cb = g.board[b.to] !== '.' || b.ep ? 1 : 0
    return cb - ca
  })
  let best = null
  let bestScore = -Infinity
  for (const m of moves) {
    const after = normalizeGame({ ...g, ...applyMove(g, m) })
    const score = -negamax(after, depth - 1, other(color), -Infinity, Infinity) + (Math.random() * 6)
    if (score > bestScore) { bestScore = score; best = m }
  }
  return best
}

function negamax(g, depth, color, alpha, beta) {
  if (depth <= 0) return evalFor(g, color)
  const moves = legalMoves(g)
  if (!moves.length) return inCheck(g) ? -100000 : 0
  let best = -Infinity
  for (const m of moves) {
    const after = normalizeGame({ ...g, ...applyMove(g, m) })
    const score = -negamax(after, depth - 1, other(color), -beta, -alpha)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

/** 电脑走一步（深 2 层：自己一步 + 对方一步），返回 {game, uci}。 */
export function aiMove(game, { depth = 2 } = {}) {
  const g = normalizeGame(game)
  if (g.status !== 'playing') return { ok: false, error: '棋局已经结束' }
  const m = searchBest(g, depth, g.turn)
  if (!m) return { ok: false, error: '没有合法走法' }
  const next = normalizeGame({ ...g, ...applyMove(g, m), moves: [...g.moves, { uci: moveToUci(m), by: g.turn, at: Date.now() }] })
  next.status = statusOf(next)
  next.updatedAt = Date.now()
  return { ok: true, game: next, uci: moveToUci(m) }
}

// ── 给模型看 / 给人看 ──────────────────────────────────────────────────────
export function renderBoard(g) {
  const rows = []
  rows.push('  a b c d e f g h')
  for (let r = 0; r < 8; r++) {
    const cells = []
    for (let f = 0; f < 8; f++) {
      const p = g.board[idxOf(r, f)]
      cells.push(p === '.' ? '·' : UNICODE[p] || p)
    }
    rows.push(`${8 - r} ${cells.join(' ')} ${8 - r}`)
  }
  rows.push('  a b c d e f g h')
  return rows.join('\n')
}

export function gameSummary(g, { includeLegal = true } = {}) {
  const legal = g.status === 'playing' ? legalMoves(g).map(moveToUci) : []
  return {
    status: g.status,
    statusText: statusText(g),
    turn: g.turn === 'w' ? '白' : '黑',
    你执: g.aiSide === 'w' ? '黑' : '白',
    board: renderBoard(g),
    lastMoves: g.moves.slice(-6).map((m) => `${m.by === 'w' ? '白' : '黑'} ${m.uci}`),
    ...(includeLegal ? { legalMoves: legal } : {})
  }
}

export function loadGame() {
  try {
    return normalizeGame(JSON.parse(fs.readFileSync(GAME_FILE, 'utf8')))
  } catch {
    return null
  }
}

export function saveGame(g) {
  const data = normalizeGame({ ...g, updatedAt: Date.now() })
  fs.mkdirSync(path.dirname(GAME_FILE), { recursive: true })
  const tmp = GAME_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, GAME_FILE)
  return data
}

export function renderBoardPage(g) {
  const rows = []
  for (let r = 0; r < 8; r++) {
    const cells = []
    for (let f = 0; f < 8; f++) {
      const p = g.board[idxOf(r, f)]
      const dark = (r + f) % 2 === 1
      cells.push(`<div class="sq ${dark ? 'dark' : 'light'}">${p === '.' ? '' : `<span class="pc ${p === p.toUpperCase() ? 'w' : 'b'}">${UNICODE[p]}</span>`}</div>`)
    }
    rows.push(`<div class="row">${cells.join('')}</div>`)
  }
  const moves = g.moves.slice(-14).map((m) => `<li>${m.by === 'w' ? '白' : '黑'} · ${m.uci}</li>`).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${env().petTitle('国际象棋')}</title>
<style>
  :root { --bg:#14110f; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; --light:#d9cbb8; --dark:#7a6753; }
  *{box-sizing:border-box}
  body{margin:0;padding:40px 20px;background:radial-gradient(900px 500px at 50% -10%,#221a13,#14110f 60%);color:var(--ink);font:15px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  header{max-width:760px;margin:0 auto 18px}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:2px;font-weight:600}
  .sub{color:var(--muted);font-size:13px}
  .sub b{color:var(--accent);font-weight:500}
  .board{width:min(560px,92vw);margin:18px auto;display:grid;border:10px solid #2b241d;border-radius:10px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  .row{display:grid;grid-template-columns:repeat(8,1fr)}
  .sq{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:min(46px,7vw);line-height:1;user-select:none}
  .sq.light{background:var(--light)} .sq.dark{background:var(--dark)}
  .pc.w{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.45)}
  .pc.b{color:#191512;text-shadow:0 1px 1px rgba(255,255,255,.25)}
  .info{max-width:560px;margin:0 auto;color:var(--muted);font-size:13px}
  .info b{color:var(--ink)}
  ul{list-style:none;padding:0;margin:8px 0 0;display:flex;flex-wrap:wrap;gap:6px}
  li{background:#221d19;border:1px solid #3a3129;border-radius:999px;padding:2px 9px;font-size:12px;color:#d9c9b4}
</style></head>
<body>
<header><h1>${env().petTitle('国际象棋')}</h1><div class="sub">书房那台电脑 · 你执 <b>${g.aiSide === 'w' ? '黑' : '白'}</b> · 现在轮到 <b>${g.turn === 'w' ? '白' : '黑'}</b> · ${statusText(g)}</div></header>
<div class="board">${rows.join('')}</div>
<div class="info">
  <div>最近几步：</div>
  <ul>${moves || '<li>还没落子</li>'}</ul>
</div>
<div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body></html>`
}

export function writeBoardPage(g) {
  const file = boardPage()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, renderBoardPage(g), 'utf8')
  return file
}
