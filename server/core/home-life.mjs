// 家里的三件"会显示状态"的东西：电视（客厅/卧室两台）、电脑、冰箱。
//
// 为什么单独一个文件（不塞进 house.json）：
//   房子会搬，这三样是**bot 的生活记录** —— 看过的片子、下过几盘棋、冰箱里有什么，
//   搬家不该清零。所以 `state/home-life.json` 跟房子分开存。
//
// 电视：两台分开记 —— 客厅那台看「中午 12:00–14:00 + 晚上 18:00–22:00」，
//   卧室那台看其余时间。开关时按**当时的时间**自动落到对应的电视上（也可以点名）。
//   每台都记：开着时正在放什么（标题+BV），关着时上次看的什么 + bot 的观后感。
// 电脑：开/关；开着时页面上直接看棋局，关着时看战绩（局数/胜/负/和/胜率）。
// 冰箱：食材清单（谁放的、什么时候），随时加/拿。

import fs from 'node:fs'
import { env } from './env.mjs'
import path from 'node:path'


export const LIFE_FILE = path.join(env().root, 'state', 'home-life.json')

const TV_ROOMS = ['living', 'bedroom']
const TV_ROOM_NAMES = { living: '客厅电视', bedroom: '卧室电视' }

function clean(str, max = 120) {
  return String(str ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 浴缸水温：常规 37–40，最高 42；没设置过按 38 算。 */
function clampTemp(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 38
  return Math.max(20, Math.min(42, Math.round(n * 10) / 10))
}

/** 放满一缸水要多久（毫秒）：1 分钟。 */
export const BATH_FILL_MS = 60000

/** 这台电视"该看"哪个时段：客厅 = 中午 12–14 点 + 晚上 18–22 点；其余时间归卧室。 */
export function tvRoomFor(ms = Date.now()) {
  const h = new Date(ms).getHours()
  return (h >= 12 && h < 14) || (h >= 18 && h < 22) ? 'living' : 'bedroom'
}

function normalizeTvRoom(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const last = r.last && typeof r.last === 'object' ? r.last : null
  const now = r.now && typeof r.now === 'object' ? r.now : null
  return {
    on: r.on === true,
    now: now ? { bvid: clean(now.bvid, 20), title: clean(now.title, 160), at: Number(now.at) || 0 } : null,
    last: last ? { bvid: clean(last.bvid, 20), title: clean(last.title, 160), review: clean(last.review, 300), at: Number(last.at) || 0 } : null
  }
}

export function normalizeLife(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const tvRaw = g.tv && typeof g.tv === 'object' ? g.tv : {}
  // 旧版是"一台电视"（tv.on / tv.now / tv.last）—— 按那条观看记录的时间迁到对应的那台
  const legacy = tvRaw.on !== undefined || tvRaw.now !== undefined || tvRaw.last !== undefined
  let tv
  if (legacy) {
    const when = Number(tvRaw.now?.at) || Number(tvRaw.last?.at) || Date.now()
    const room = tvRoomFor(when)
    tv = { living: normalizeTvRoom({}), bedroom: normalizeTvRoom({}) }
    if (tvRaw.on === true) tv[room] = normalizeTvRoom({ on: true, now: tvRaw.now })
    if (tvRaw.last) tv[room].last = normalizeTvRoom({ last: tvRaw.last }).last
  } else {
    tv = { living: normalizeTvRoom(tvRaw.living), bedroom: normalizeTvRoom(tvRaw.bedroom) }
  }
  const pc = g.pc && typeof g.pc === 'object' ? g.pc : {}
  const fridge = g.fridge && typeof g.fridge === 'object' ? g.fridge : {}
  const chess = g.chess && typeof g.chess === 'object' ? g.chess : {}
  const snake = g.snake && typeof g.snake === 'object' ? g.snake : {}
  const tank = g.tank && typeof g.tank === 'object' ? g.tank : {}
  const gomoku = g.gomoku && typeof g.gomoku === 'object' ? g.gomoku : {}
  const bath = g.bath && typeof g.bath === 'object' ? g.bath : {}
  const diary = g.diary && typeof g.diary === 'object' ? g.diary : {}
  const GAMES = ['chess', 'gomoku', 'snake']
  return {
    version: 5,
    tv,
    pc: {
      on: pc.on === true,
      // bot 上一次玩的游戏（书房状态栏就显示它的成绩）
      lastGame: GAMES.includes(String(pc.lastGame)) ? String(pc.lastGame) : null,
      lastGameAt: Number(pc.lastGameAt) || 0
    },
    // 正在做的日常活动（做饭 / 吃饭 / 游泳 / 晒太阳 / 读书 / 睡觉…）
    leisure: g.leisure && typeof g.leisure === 'object' && clean(g.leisure.what)
      ? {
          what: clean(g.leisure.what, 30),
          room: clean(g.leisure.room, 20),
          at: Number(g.leisure.at) || 0,
          until: Number(g.leisure.until) || 0
        }
      : null,
    // 就餐（做饭→吃饭→饭后休息）的进度 + 饭点设置
    meal: {
      config: g.meal?.config && typeof g.meal.config === 'object' ? g.meal.config : {},
      active: g.meal?.active && typeof g.meal.active === 'object'
        ? {
            kind: String(g.meal.active.kind || ''),
            phase: String(g.meal.active.phase || 'cooking'),
            startedAt: Number(g.meal.active.startedAt) || 0,
            cookMinutes: Math.max(0, Number(g.meal.active.cookMinutes) || 0),
            eatMinutes: Math.max(0, Number(g.meal.active.eatMinutes) || 0),
            done: g.meal.active.done === true,
            // timer = 状态机排的；self = 她自己想做；owner = 主人叫的
            source: ['timer', 'self', 'owner'].includes(String(g.meal.active.source))
              ? String(g.meal.active.source)
              : 'timer'
          }
        : null,
      lastMealAt: Number(g.meal?.lastMealAt) || 0,
      decided: g.meal?.decided && typeof g.meal.decided === 'object' ? g.meal.decided : {},
      decidedDay: String(g.meal?.decidedDay || ''),
      supperDecided: g.meal?.supperDecided && typeof g.meal.supperDecided === 'object' ? g.meal.supperDecided : null
    },
    // 最近一次就餐事件（状态机自动推进后写，供页头/唤醒提示/qq_house 展示）
    mealLastEvent: g.mealLastEvent && typeof g.mealLastEvent === 'object' && clean(g.mealLastEvent.text)
      ? {
          text: clean(g.mealLastEvent.text, 80),
          at: Number(g.mealLastEvent.at) || 0,
          kind: clean(g.mealLastEvent.kind, 20) || '',
          acted: clean(g.mealLastEvent.acted, 20) || ''
        }
      : null,
    // 卫生间浴缸：放水 1 分钟满，水温 37–40（上限 42）
    bath: {
      on: bath.on === true,
      startedAt: Number(bath.startedAt) || 0,
      temp: clampTemp(bath.temp),
      last: bath.last && typeof bath.last === 'object'
        ? { at: Number(bath.last.at) || 0, pct: Math.max(0, Math.min(100, Math.round(Number(bath.last.pct) || 0))), temp: clampTemp(bath.last.temp) }
        : null
    },
    // 书房笔记本：bot 写的日记（主人能不能看由 house-prefs 的 diaryVisible 决定）
    diary: {
      entries: Array.isArray(diary.entries)
        ? diary.entries
          .filter((x) => x && clean(x.text))
          .map((x) => ({ at: Number(x.at) || 0, text: clean(x.text, 800) }))
          .slice(-100)
        : [],
      lastAt: Number(diary.lastAt) || 0
    },
    fridge: {
      items: Array.isArray(fridge.items)
        ? fridge.items.filter((x) => x && clean(x.name)).slice(-80).map((x) => ({ name: clean(x.name, 40), by: clean(x.by, 20) || '', at: Number(x.at) || 0 }))
        : []
    },
    // 客厅鱼缸里养着什么
    tank: {
      fish: Array.isArray(tank.fish)
        ? tank.fish.filter((x) => x && clean(x.name)).slice(-20).map((x) => ({ name: clean(x.name, 30), by: clean(x.by, 20) || '', at: Number(x.at) || 0 }))
        : []
    },
    chess: {
      games: Math.max(0, Number(chess.games) || 0),
      wins: Math.max(0, Number(chess.wins) || 0),
      losses: Math.max(0, Number(chess.losses) || 0),
      draws: Math.max(0, Number(chess.draws) || 0),
      last: chess.last && typeof chess.last === 'object' ? { result: clean(chess.last.result, 10), detail: clean(chess.last.detail, 120), at: Number(chess.last.at) || 0 } : null,
      lastAt: Number(chess.lastAt) || 0
    },
    // 五子棋（跟主人下）的战绩：按 bot 的胜负算
    gomoku: {
      games: Math.max(0, Number(gomoku.games) || 0),
      wins: Math.max(0, Number(gomoku.wins) || 0),
      losses: Math.max(0, Number(gomoku.losses) || 0),
      draws: Math.max(0, Number(gomoku.draws) || 0),
      last: gomoku.last && typeof gomoku.last === 'object' ? { result: clean(gomoku.last.result, 10), detail: clean(gomoku.last.detail, 120), at: Number(gomoku.last.at) || 0 } : null,
      lastAt: Number(gomoku.lastAt) || 0
    },
    // 贪吃蛇：只留最高三次（分数 + 时间），其它一概不存
    snake: {
      best: Array.isArray(snake.best)
        ? snake.best
          .filter((x) => x && Number.isFinite(Number(x.score)))
          .map((x) => ({ score: Math.max(0, Math.round(Number(x.score))), at: Number(x.at) || 0 }))
          .sort((a, b) => b.score - a.score || b.at - a.at)
          .slice(0, 3)
        : []
    }
  }
}

export function loadLife() {
  const read = (f) => normalizeLife(JSON.parse(fs.readFileSync(f, 'utf8')))
  // 写的时候会先写 .tmp 再改名，读的瞬间可能撞上，所以重试两次
  for (let i = 0; i < 2; i++) {
    try { return read(LIFE_FILE) } catch { /* 再试一次 / 退备份 */ }
  }
  try { return read(LIFE_FILE + '.bak.json') } catch { /* 备份也没有 */ }
  return normalizeLife({})
}

export function saveLife(life) {
  // 防呆：收到的必须是 life 对象（比如 clearLeisure() 返回的是 {ok, life} 包装，不能直接传进来）
  if (!life || typeof life !== 'object' || !life.tv || !life.fridge) {
    throw new Error('saveLife 收到的不是 home-life 对象（可能是 {ok, life} 这类包装，记得取 .life）')
  }
  const data = normalizeLife(life)
  fs.mkdirSync(path.dirname(LIFE_FILE), { recursive: true })
  // 覆盖前留一份备份，万一以后写坏了还能捞回来
  try { if (fs.existsSync(LIFE_FILE)) fs.copyFileSync(LIFE_FILE, LIFE_FILE + '.bak.json') } catch { /* 备份失败不挡存档 */ }
  const tmp = LIFE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, LIFE_FILE)
  return data
}

function resolveTv(life, rawRoom, at) {
  return TV_ROOMS.includes(String(rawRoom || '').trim()) ? String(rawRoom).trim() : tvRoomFor(at)
}

/** 开电视：按当时时间落到客厅或卧室那台（也可以点名），记下正在看什么。 */
export function tvOn(life, { bvid = '', title = '', room = '' } = {}, now = Date.now()) {
  const l = normalizeLife(life)
  const r = resolveTv(l, room, now)
  l.tv[r].on = true
  l.tv[r].now = { bvid: clean(bvid, 20), title: clean(title, 160) || l.tv[r].now?.title || '', at: now }
  return {
    ok: true,
    life: l,
    room: r,
    message: `${TV_ROOM_NAMES[r]}开了${l.tv[r].now.title ? `，正在放《${l.tv[r].now.title}》` : ''}`
  }
}

/** 关电视：默认关"正在开的那台"（两台都开就关最近开的那台），把这集挪进"上次看的"。 */
export function tvOff(life, { review = '', room = '' } = {}, now = Date.now()) {
  const l = normalizeLife(life)
  let r = TV_ROOMS.includes(String(room || '').trim()) ? String(room).trim() : ''
  if (!r) {
    const onRooms = TV_ROOMS.filter((x) => l.tv[x].on)
    if (onRooms.length === 0) return { ok: true, life: l, changed: false, message: '电视本来就关着' }
    r = onRooms.sort((a, b) => (l.tv[b].now?.at || 0) - (l.tv[a].now?.at || 0))[0]
  }
  const cur = l.tv[r].now
  l.tv[r].on = false
  l.tv[r].now = null
  if (cur) l.tv[r].last = { bvid: cur.bvid, title: cur.title, review: clean(review, 300), at: now }
  return {
    ok: true,
    life: l,
    room: r,
    changed: true,
    message: cur
      ? `${TV_ROOM_NAMES[r]}关了。上次看的是《${cur.title}》${review ? '，观后感记下了' : '（观后感没写）'}`
      : `${TV_ROOM_NAMES[r]}关了`
  }
}

/**
 * 各类日常活动的「自然时长」（分钟）。到点后 leisure 自动失效，
 * 免得手动做一次饭就永久挂着「正在做饭」不结束。
 * 没列到的走 DEFAULT_LEISURE_MINUTES。
 */
const LEISURE_MINUTES = {
  做饭: 25,
  吃饭: 30,
  洗澡: 30,
  泡澡: 40,
  游泳: 40,
  晒太阳: 60,
  读书: 90,
  睡觉: 480,
  收拾: 30,
  发呆: 30
}
const DEFAULT_LEISURE_MINUTES = 60

/** 这个活动大概会持续多久（毫秒）。 */
function leisureTtlMs(what) {
  const w = String(what || '')
  for (const [k, min] of Object.entries(LEISURE_MINUTES)) {
    if (w.includes(k)) return min * 60000
  }
  return DEFAULT_LEISURE_MINUTES * 60000
}

/** 记下「正在做什么」（配合 moveTo 让位置和活动一致）。会带一个自然结束时间。 */
export function setLeisure(life, what, room, now = Date.now()) {
  const l = normalizeLife(life)
  const w = clean(what, 30)
  if (!w) { l.leisure = null; return { ok: true, life: l, changed: true, message: '不做什么了' } }
  l.leisure = { what: w, room: clean(room, 20), at: now, until: now + leisureTtlMs(w) }
  return { ok: true, life: l, changed: true, message: `正在${w}` }
}

/**
 * 让过期的 leisure 自然结束。
 * 返回 { life, expired } —— expired 为 true 表示这次真的把它清掉了。
 * 调用方（各处 tick / 状态查询）顺手跑一下就行。
 */
export function expireLeisure(life, now = Date.now()) {
  const l = normalizeLife(life)
  if (!l.leisure) return { life: l, expired: false }
  // 没记 until 的（老数据）按默认时长从 at 推算
  const until = Number(l.leisure.until) || (Number(l.leisure.at) + leisureTtlMs(l.leisure.what))
  if (now < until) return { life: l, expired: false }
  const what = l.leisure.what
  l.leisure = null
  return { life: l, expired: true, what }
}

export function clearLeisure(life) {
  const l = normalizeLife(life)
  l.leisure = null
  return { ok: true, life: l, changed: true, message: '不做什么了' }
}

// ── 浴缸（卫生间）──────────────────────────────────────────────────────
/** 放水：1 分钟放满；水温默认 37–40 随机，也可以指定（上限 42）。 */
export function bathOn(life, { temp } = {}, now = Date.now()) {
  const l = normalizeLife(life)
  const wanted = Number(temp)
  const degree = Number.isFinite(wanted) && wanted > 0
    ? clampTemp(wanted)
    : Math.round((37 + Math.random() * 3) * 10) / 10
  l.bath.on = true
  l.bath.startedAt = now
  l.bath.temp = degree
  const note = Number.isFinite(wanted) && wanted > 42 ? '（42 度是上限，再热就烫了）' : ''
  return { ok: true, life: l, changed: true, temp: degree, message: `浴缸开始放水，水温 ${degree}°C${note}` }
}

/** 关水/起身：记一下这次泡了多久、水放到多少。 */
export function bathOff(life, now = Date.now()) {
  const l = normalizeLife(life)
  const minutes = l.bath.on ? Math.max(0, Math.round(((now - l.bath.startedAt) / 60000) * 10) / 10) : 0
  const pct = l.bath.on ? Math.min(100, Math.round(((now - l.bath.startedAt) / BATH_FILL_MS) * 100)) : 0
  l.bath.last = { at: now, pct, temp: l.bath.temp }
  l.bath.on = false
  l.bath.startedAt = 0
  return { ok: true, life: l, changed: true, minutes, pct, message: `浴缸关了（这次放到 ${pct}%，泡了 ${minutes} 分钟）` }
}

/** 当前浴缸状态：水量百分比（1 分钟满）、水温、已经放了多久。 */
export function bathStatus(life, now = Date.now()) {
  const l = normalizeLife(life)
  if (!l.bath.on) {
    return { on: false, pct: l.bath.last?.pct || 0, temp: l.bath.last?.temp || l.bath.temp, last: l.bath.last }
  }
  const pct = Math.min(100, Math.round(((now - l.bath.startedAt) / BATH_FILL_MS) * 100))
  const mins = Math.max(0, Math.round(((now - l.bath.startedAt) / 60000) * 10) / 10)
  return { on: true, pct, temp: l.bath.temp, minutes: mins }
}

// ── 笔记本（书房）：bot 写的日记 ────────────────────────────────────────
export function diaryWrite(life, text, now = Date.now()) {
  const l = normalizeLife(life)
  const body = clean(text, 800)
  if (!body) return { ok: false, error: '日记不能是空的' }
  l.diary.entries.push({ at: now, text: body })
  l.diary.entries = l.diary.entries.slice(-100)
  l.diary.lastAt = now
  return { ok: true, life: l, changed: true, count: l.diary.entries.length, message: `写进日记了（第 ${l.diary.entries.length} 篇）` }
}

export function diaryEntries(life) {
  return normalizeLife(life).diary.entries
}

export function pcOn(life, now = Date.now()) {
  const l = normalizeLife(life)
  const changed = !l.pc.on
  l.pc.on = true
  return { ok: true, life: l, changed, at: now, message: '电脑开了' }
}

export function pcOff(life) {
  const l = normalizeLife(life)
  const changed = l.pc.on
  l.pc.on = false
  return { ok: true, life: l, changed, message: '电脑关了' }
}

/** 往冰箱里放东西（同一个名字不重复放；放过的会更新"谁放的/什么时候"）。 */
export function fridgeAdd(life, rawItem, by = env().petName(), now = Date.now()) {
  const l = normalizeLife(life)
  const name = clean(rawItem, 40)
  if (!name) return { ok: false, error: '食材名不能空' }
  const exist = l.fridge.items.find((x) => x.name === name)
  if (exist) { exist.by = clean(by, 20); exist.at = now; return { ok: true, life: l, changed: false, message: `冰箱里已经有「${name}」了` } }
  l.fridge.items.push({ name, by: clean(by, 20), at: now })
  l.fridge.items = l.fridge.items.slice(-80)
  return { ok: true, life: l, changed: true, message: `往冰箱里放了「${name}」` }
}

export function fridgeRemove(life, rawItem) {
  const l = normalizeLife(life)
  const q = clean(rawItem, 40)
  const hit = l.fridge.items.find((x) => x.name === q) || l.fridge.items.find((x) => x.name.includes(q) || q.includes(x.name))
  if (!hit) return { ok: false, error: `冰箱里没找到「${rawItem}」` }
  l.fridge.items = l.fridge.items.filter((x) => x !== hit)
  return { ok: true, life: l, changed: true, message: `从冰箱里拿了「${hit.name}」` }
}

/** 往鱼缸里放一条鱼（同名不重复放）。 */
export function tankAdd(life, rawName, by = env().petName(), now = Date.now()) {
  const l = normalizeLife(life)
  const name = clean(rawName, 30)
  if (!name) return { ok: false, error: '鱼的名字不能空' }
  const exist = l.tank.fish.find((x) => x.name === name)
  if (exist) { exist.by = clean(by, 20); exist.at = now; return { ok: true, life: l, changed: false, message: `鱼缸里已经有「${name}」了` } }
  if (l.tank.fish.length >= 20) return { ok: false, error: '鱼缸太挤了（最多 20 条）' }
  l.tank.fish.push({ name, by: clean(by, 20), at: now })
  return { ok: true, life: l, changed: true, message: `鱼缸里多了一条「${name}」` }
}

/** 从鱼缸里捞走一条鱼（认全名，也认半截）。 */
export function tankRemove(life, rawName) {
  const l = normalizeLife(life)
  const q = clean(rawName, 30)
  const hit = l.tank.fish.find((x) => x.name === q) || l.tank.fish.find((x) => x.name.includes(q) || q.includes(x.name))
  if (!hit) return { ok: false, error: `鱼缸里没找到「${rawName}」` }
  l.tank.fish = l.tank.fish.filter((x) => x !== hit)
  return { ok: true, life: l, changed: true, message: `把「${hit.name}」从鱼缸里捞走了` }
}

/** 一盘棋下完，记一次战绩（每局只记一次，调用方负责去重）。 */
export function recordChessResult(life, result, detail = '', now = Date.now()) {
  const l = normalizeLife(life)
  l.chess.games += 1
  if (result === 'win') l.chess.wins += 1
  else if (result === 'loss') l.chess.losses += 1
  else l.chess.draws += 1
  l.chess.last = { result, detail: clean(detail, 120), at: now }
  l.chess.lastAt = now
  return l
}

/** 把战绩清零（"那盘测试的棋不算"用）。 */
export function resetChessStats(life) {
  const l = normalizeLife(life)
  l.chess = { games: 0, wins: 0, losses: 0, draws: 0, last: null, lastAt: 0 }
  return l
}

export function chessStats(chess) {
  const c = normalizeLife({ chess }).chess
  const games = c.games
  const winRate = games > 0 ? Math.round((c.wins / games) * 1000) / 10 : 0
  return { ...c, winRate }
}

/** 记「上一次玩的是哪个游戏」（书房状态栏显示它的成绩）。 */
export function setLastGame(life, game, now = Date.now()) {
  const l = normalizeLife(life)
  const name = String(game || '').trim()
  if (!['chess', 'gomoku', 'snake'].includes(name)) return l
  l.pc.lastGame = name
  l.pc.lastGameAt = now
  return l
}

/** 一盘五子棋下完，记一次战绩（按 **bot** 的胜负；每局只记一次，调用方去重）。 */
export function recordGomokuResult(life, result, detail = '', now = Date.now()) {
  const l = normalizeLife(life)
  l.gomoku.games += 1
  if (result === 'win') l.gomoku.wins += 1
  else if (result === 'loss') l.gomoku.losses += 1
  else l.gomoku.draws += 1
  l.gomoku.last = { result, detail: clean(detail, 120), at: now }
  l.gomoku.lastAt = now
  return l
}

export function gomokuStats(chessLike) {
  const c = normalizeLife({ gomoku: chessLike }).gomoku
  const games = c.games
  const winRate = games > 0 ? Math.round((c.wins / games) * 1000) / 10 : 0
  return { ...c, winRate }
}

/** 贪吃蛇记一次分数，只留最高三次。 */
export function recordSnakeScore(life, score, now = Date.now()) {
  const l = normalizeLife(life)
  const s = Math.max(0, Math.round(Number(score) || 0))
  l.snake.best = [...l.snake.best, { score: s, at: now }]
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, 3)
  return l
}

export function snakeBest(life) {
  return normalizeLife(life).snake.best
}

/** 变成给模型看/给页面用的一小段文字。 */
export function lifeLines(life) {
  const l = normalizeLife(life)
  const lines = []
  for (const r of TV_ROOMS) {
    const tv = l.tv[r]
    if (tv.on) lines.push(`${TV_ROOM_NAMES[r]}：开着${tv.now?.title ? `，正在放《${tv.now.title}》` : ''}`)
    else if (tv.last) lines.push(`${TV_ROOM_NAMES[r]}：关着；上次看《${tv.last.title}》${tv.last.review ? `，观后感：${tv.last.review}` : ''}`)
    else lines.push(`${TV_ROOM_NAMES[r]}：关着，还没看过东西`)
  }
  const GAME_NAMES = { chess: '国际象棋', gomoku: '五子棋', snake: '贪吃蛇' }
  const lastGame = l.pc.lastGame
  let playLine = '电脑：还没玩过游戏'
  if (lastGame === 'snake') {
    const best = l.snake.best.map((b) => b.score)
    playLine = `上次玩贪吃蛇${best.length ? `，最高 ${best.join(' / ')}` : '（还没得分）'}`
  } else if (lastGame === 'chess' || lastGame === 'gomoku') {
    const s = lastGame === 'chess' ? chessStats(l.chess) : gomokuStats(l.gomoku)
    playLine = `上次玩${GAME_NAMES[lastGame]}，${s.games} 局 · 胜 ${s.wins} · 负 ${s.losses} · 和 ${s.draws} · 胜率 ${s.winRate}%`
  }
  lines.push(`电脑：${l.pc.on ? '开着' : '关着'}；${playLine}`)
  lines.push(l.fridge.items.length ? `冰箱：${l.fridge.items.map((x) => x.name).join('、')}` : '冰箱：空的')
  lines.push(l.tank.fish.length ? `鱼缸：${l.tank.fish.map((x) => x.name).join('、')}` : '鱼缸：空的')
  const bathInfo = bathStatus(l)
  if (bathInfo.on) lines.push(`浴缸：开着，水量 ${bathInfo.pct}%，水温 ${bathInfo.temp}°C`)
  else if (l.bath.last) lines.push(`浴缸：关着（上次放到 ${l.bath.last.pct}%，水温 ${l.bath.last.temp}°C）`)
  else lines.push('浴缸：关着，还没放过水')
  if (l.leisure) lines.push(`正在：${l.leisure.what}${l.leisure.room ? `（${l.leisure.room}）` : ''}`)
  // 刚发生的就餐事件（状态机会在她不知情的时候自动推进，这里让她自己也能看到）
  if (l.mealLastEvent?.text) {
    const ago = l.mealLastEvent.at ? Math.max(0, Math.round((Date.now() - l.mealLastEvent.at) / 60000)) : null
    if (ago !== null && ago <= 180) lines.push(`刚吃：${l.mealLastEvent.text}（${ago} 分钟前）`)
  }
  lines.push(l.diary.entries.length
    ? `笔记本：日记 ${l.diary.entries.length} 篇，最新一篇：${l.diary.entries[l.diary.entries.length - 1].text.slice(0, 40)}`
    : '笔记本：日记还是空的')
  return lines.join('\n')
}
