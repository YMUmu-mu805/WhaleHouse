// bot 的小房子 —— 独立 MCP 服务（分享给朋友用）
//
// 跟 QQ 桥接里那套是同一批模块（house / home-life / chess / snake / gomoku），
// 但这里不依赖桥接、不依赖 QQ、不需要控制台令牌：
//   数据：./state/*.json      页面：./exports/*.html
//
// 用法：node src/mcp-server.mjs            （由 DSH 的 MCP 客户端以 stdio 拉起）
//       node src/mcp-server.mjs --selftest （不接 DSH，跑一遍自检，验证装好没有）
//
// 工具一览：
//   房子：qq_house / qq_house_move / qq_house_furniture
//   家电：qq_house_tv / qq_house_pc / qq_house_fridge / qq_house_tank
//   棋牌：qq_chess / qq_chess_new / qq_chess_move / qq_chess_resign
//         qq_snake / qq_snake_new / qq_snake_step
//         qq_gomoku / qq_gomoku_ready / qq_gomoku_place / qq_gomoku_skill

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { PET_NAME, petTitle } from './who.mjs'
import { notifyHouseChanged, notifyHouseAsk } from './qqshot.mjs'
import { loadHouse, saveHouse, moveTo, addFurniture, removeFurniture, moveFurniture, houseSummary, writePage, HOUSE_STYLES, HOUSE_FILE } from './house.mjs'
import { loadLife, saveLife, setLeisure, clearLeisure, expireLeisure, tvOn, tvOff, pcOn, pcOff, fridgeAdd, fridgeRemove, tankAdd, tankRemove, bathOn, bathOff, bathStatus, diaryWrite, diaryEntries, setLastGame, recordGomokuResult, chessStats, gomokuStats, recordChessResult, recordSnakeScore, snakeBest, lifeLines } from './home-life.mjs'
import { tickMeal, mealStatus, normalizeMealConfig, DEFAULT_MEALS, toMinutes, mealConfigText, flattenMealConfig, manualMeal, forceMeal, guessMealKind } from './meal.mjs'
import { newGame as newChessGame, loadGame as loadChess, saveGame as saveChess, playMove, aiMove, gameSummary as chessSummary, normalizeGame, writeBoardPage, resign } from './chess.mjs'
import { newGame as newSnakeGame, loadSnake, saveSnake, stepMany, gameSummary as snakeSummary, writePage as writeSnakePage } from './snake.mjs'
import { loadOrCreate as loadGomoku, saveGomoku, place as gomokuPlace, armSkill as gomokuArm, readyUp, canStart as gomokuCanStart, startGame as gomokuStart, parseCell, skillStatus, renderBoard, statusText as gomokuStatusText, whaleResult, writePage as writeGomokuPage, BLACK, WHITE } from './gomoku.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const STATE = path.join(ROOT, 'state')
const EXPORT = path.join(ROOT, 'exports')
fs.mkdirSync(STATE, { recursive: true })
fs.mkdirSync(EXPORT, { recursive: true })

/** 第一次跑：没有 house.json 就按"普通小屋"建一栋。 */
function ensureHouse() {
  if (fs.existsSync(HOUSE_FILE)) return
  const seed = {
    name: petTitle('小房子'),
    owner: PET_NAME,
    style: 'plain',
    current: HOUSE_STYLES.plain.rooms[0].id,
    movedAt: 0,
    rooms: HOUSE_STYLES.plain.rooms.map((r) => ({ ...r, items: [...r.items] })),
    log: [],
    history: []
  }
  saveHouse(seed)
  try { writePage(seed) } catch { /* 页面画不出来不影响数据 */ }
}

// ── settings.json：服务器版的几个开关（直接改文件也行）──────────────────
const SETTINGS_FILE = path.join(ROOT, 'settings.json')
const DEFAULT_SETTINGS = { diaryVisible: false, interactiveFurniture: true }

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return {
      diaryVisible: raw?.diaryVisible === true,
      interactiveFurniture: raw?.interactiveFurniture !== false
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) }
  const clean = { diaryVisible: next.diaryVisible === true, interactiveFurniture: next.interactiveFurniture !== false }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  // 日记开关同步进 state/house-prefs.json，页面渲染用的是那份
  try {
    const prefsFile = path.join(STATE, 'house-prefs.json')
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) } catch { /* 没有就算了 */ }
    fs.writeFileSync(prefsFile, JSON.stringify({ ...cur, diaryVisible: clean.diaryVisible }, null, 2) + '\n', 'utf8')
  } catch { /* 同步失败不影响设置本身 */ }
  return clean
}

// 可互动家具（带状态栏）：电视能删但至少留一台，其它默认不能删
const INTERACTIVE = [
  { kind: 'tv', word: '电视' },
  { kind: 'pc', word: '电脑' },
  { kind: 'fridge', word: '冰箱' },
  { kind: 'tank', word: '鱼缸' },
  { kind: 'bath', word: '浴缸' },
  { kind: 'diary', word: '笔记本' }
]
const interactiveOf = (item) => INTERACTIVE.find((x) => String(item).includes(x.word)) || null
const tvTotal = (house) => house.rooms.reduce((n, r) => n + r.items.filter((i) => i.includes('电视')).length, 0)
const MUST_KEEP_ROOMS = ['卧室', '厨房', '卫生间']

const syncHome = () => { try { writePage(loadHouse()) } catch { /* ignore */ } }
const J = (v) => JSON.stringify(v, null, 2)
const otherSide = (c) => (c === 'w' ? 'b' : 'w')

// 惰性推进吃饭状态机：每次房子工具被调用时顺带 tick 一下。
// 到饭点只报 due（提醒），不自动开火；手动开的那顿才推进。
function mealTick() {
  // 先让过期的手动活动自然结束（做饭 25 分钟、吃饭 30 分钟…到点就收），
  // 否则手动做一次饭会一直挂着「正在做饭」不结束。
  try {
    const ex = expireLeisure(loadLife())
    if (ex.expired) {
      saveLife(ex.life)
      syncHome()
    }
  } catch { /* 过期清理失败不影响下面的就餐推进 */ }

  const r = tickMeal(loadLife())
  if (!r.acted) return r

  if (r.acted === 'due') {
    // 到饭点：只提醒（写 mealLastEvent），不搬人、不自动开火。
    saveLife(r.life)
    try {
      const life = loadLife()
      life.mealLastEvent = { text: `到饭点了，该吃${['breakfast', 'lunch', 'dinner', 'supper'].includes(r.kind) ? { breakfast: '早饭', lunch: '午饭', dinner: '晚饭', supper: '夜宵' }[r.kind] : '饭'}了`, at: Date.now(), kind: r.kind, acted: 'due' }
      saveLife(life)
    } catch { /* 记录失败不影响 */ }
    return r
  }

  // 以下是「手动开的那顿」在推进（eating / rest）：需要同步挪人
  try {
    const house = loadHouse()
    const want = r.acted === 'eating' ? 'dining'
      : (r.room || '')
    if (want) {
      const target = house.rooms.find((x) => x.id === want) || house.rooms.find((x) => x.name === want)
      if (target && house.current !== target.id) {
        const moved = moveTo(house, target.id)
        if (moved && moved.ok) saveHouse(moved.house || house)
      }
    }
  } catch { /* 挪不动也不影响状态推进 */ }
  saveLife(r.life)
  syncHome()
  return r
}

// ── 具体做法（工具与自检共用同一套） ────────────────────────────────────────
// 用家电之前先「走过去」：让位置也跟着变
const goTo = (roomId) => {
  try {
    const house = loadHouse()
    const target = house.rooms.find((r) => r.id === roomId) || house.rooms.find((r) => r.name === roomId)
    if (!target) return ''
    if (house.current === target.id) return ''
    // 换了地方就不再是「正在做之前那件事」
    try { const cur = loadLife(); if (cur.leisure) { const c = clearLeisure(cur); if (c.changed) saveLife(c.life) } } catch { /* 清活动失败不影响动作 */ }
    const r = moveTo(house, target.id)
    if (!r || !r.ok) return ''
    saveHouse(r.house || house)
    try { writePage(loadHouse()) } catch { /* 页面画不出来不影响动作 */ }
    return `（先走到${target.name}）\n`
  } catch {
    return ''
  }
}

const DO = {
  house() {
    ensureHouse()
    mealTick()
    const life = loadLife()
    // 被问「小屋怎么样」时，若配了 QQ 通道且开了开关，顺手发一张当前截图
    notifyHouseAsk()
    return J(houseSummary(loadHouse())) + '\n\n【家里】\n' + lifeLines(life)
  },
  houseMove(room) {
    ensureHouse()
    const r = moveTo(loadHouse(), room)
    if (!r.ok) throw new Error(r.error)
    if (r.moved) { saveHouse(r.house); syncHome(); notifyHouseChanged('move') }
    return r.message + '。现在在' + (r.house.rooms.find((x) => x.id === r.house.current)?.name || '') + '。'
  },
  furniture(action, item, room) {
    ensureHouse()
    const h = loadHouse()
    let r
    if (action === 'add') r = addFurniture(h, room, item)
    else if (action === 'remove') {
      // 可互动家具保护（settings.json 的 interactiveFurniture，默认开）
      const kind = interactiveOf(item)
      if (kind && readSettings().interactiveFurniture) {
        if (kind.kind === 'tv') {
          if (tvTotal(h) <= 1) throw new Error('至少要留一台电视')
        } else {
          throw new Error(`「${item}」是可互动家具（带状态栏），不能删；想允许删就把 settings.json 的 interactiveFurniture 设为 false`)
        }
      }
      r = removeFurniture(h, item)
    }
    else r = moveFurniture(h, item, room)
    if (!r.ok) throw new Error(r.error)
    if (r.changed) { saveHouse(r.house); syncHome(); notifyHouseChanged('layout') }
    return r.message
  },
  tv(action, bvid, title, review, room) {
    const walked = goTo(room || (room === undefined ? 'living' : room))
    let life = loadLife()
    let msg = ''
    if (action === 'on') { const r = tvOn(life, { bvid, title, room }); life = saveLife(r.life); msg = r.message }
    else if (action === 'off') { const r = tvOff(life, { review, room }); life = saveLife(r.life); msg = r.message }
    syncHome()
    return walked + msg + '\n' + lifeLines(life)
  },
  pc(action) {
    const walked = goTo('study')
    let life = loadLife()
    let msg = ''
    if (action === 'on') { const r = pcOn(life); life = saveLife(r.life); msg = r.message }
    else if (action === 'off') { const r = pcOff(life); life = saveLife(r.life); msg = r.message }
    syncHome()
    const s = chessStats(life.chess)
    return `${walked}${msg || ''}\n电脑：${life.pc.on ? '开着' : '关着'} · ${s.games} 局 · 胜 ${s.wins} · 负 ${s.losses} · 和 ${s.draws} · 胜率 ${s.winRate}%`
  },
  fridge(action, item) {
    const walked = goTo('kitchen')
    let life = loadLife()
    let msg = ''
    if (action === 'add') { const r = fridgeAdd(life, item); if (!r.ok) throw new Error(r.error); life = saveLife(r.life); msg = r.message }
    else if (action === 'remove') { const r = fridgeRemove(life, item); if (!r.ok) throw new Error(r.error); life = saveLife(r.life); msg = r.message }
    syncHome()
    return `${walked}${msg || ''}\n冰箱：${life.fridge.items.length ? life.fridge.items.map((x) => x.name).join('、') : '空的'}`
  },
  tank(action, fish) {
    const walked = goTo('living')
    let life = loadLife()
    let msg = ''
    if (action === 'add') { const r = tankAdd(life, fish); if (!r.ok) throw new Error(r.error); life = saveLife(r.life); msg = r.message }
    else if (action === 'remove') { const r = tankRemove(life, fish); if (!r.ok) throw new Error(r.error); life = saveLife(r.life); msg = r.message }
    syncHome()
    return `${walked}${msg || ''}\n鱼缸：${life.tank.fish.length ? life.tank.fish.map((x) => x.name).join('、') : '空的'}`
  },
  bath(action, temp) {
    const walked = goTo('bathroom')
    let life = loadLife()
    let msg = ''
    if (action === 'on') { const r = bathOn(life, { temp }); life = saveLife(r.life); msg = r.message }
    else if (action === 'off') { const r = bathOff(life); life = saveLife(r.life); msg = r.message }
    syncHome()
    const st = bathStatus(life)
    const line = st.on
      ? `浴缸：开着，水量 ${st.pct}%，水温 ${st.temp}°C`
      : (st.last ? `浴缸：关着（上次放到 ${st.last.pct}%，水温 ${st.last.temp}°C）` : '浴缸：关着')
    return `${walked}${msg || ''}\n${line}`
  },
  diary(action, text) {
    const walked = goTo('study')
    let life = loadLife()
    let msg = ''
    if (action === 'write') {
      const r = diaryWrite(life, text)
      if (!r.ok) throw new Error(r.error)
      life = saveLife(r.life)
      msg = r.message
      syncHome()
    }
    const entries = diaryEntries(life).slice().reverse().slice(0, 5)
    const body = entries.length
      ? entries.map((e) => `· ${new Date(e.at).toLocaleString('zh-CN', { hour12: false })} ${e.text}`).join('\n')
      : '还没写过什么。'
    return `${walked}${msg || ''}\n笔记本里最近几篇：\n${body}`
  },
  setting(action, diaryVisible, interactiveFurniture) {
    if (action === 'set') {
      const patch = {}
      if (typeof diaryVisible === 'boolean') patch.diaryVisible = diaryVisible
      if (typeof interactiveFurniture === 'boolean') patch.interactiveFurniture = interactiveFurniture
      const next = writeSettings(patch)
      try { writePage(loadHouse()) } catch { /* 页面重画失败不影响设置 */ }
      return `日记：${next.diaryVisible ? '可随时查看' : '不查看'} · 可互动家具：${next.interactiveFurniture ? '受保护（不能删）' : '不保护（可以删）'}`
    }
    const cur = readSettings()
    return `日记：${cur.diaryVisible ? '可随时查看' : '不查看'} · 可互动家具：${cur.interactiveFurniture ? '受保护（不能删）' : '不保护（可以删）'}（配置文件：settings.json）`
  },
  room(action, name, moveTo) {
    const house = loadHouse()
    if (action === 'add') {
      const roomName = String(name || '').trim()
      if (!roomName) throw new Error('房间名不能为空')
      if (roomName.length > 10) throw new Error('房间名太长（最多 10 字）')
      if (house.rooms.some((r) => r.name === roomName)) throw new Error(`已经有「${roomName}」了`)
      house.rooms.push({
        id: 'room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: roomName,
        icon: '🏠',
        items: [],
        desc: ''
      })
      saveHouse(house)
      syncHome()
      notifyHouseChanged('layout')
      return `加了「${roomName}」。现在 ${house.rooms.length} 间屋。`
    }

    if (action === 'remove') {
      const target = house.rooms.find((r) => r.name === String(name || '').trim() || r.id === String(name || '').trim())
      if (!target) throw new Error(`没有「${name}」这间屋`)
      if (MUST_KEEP_ROOMS.includes(target.name)) throw new Error(`「${target.name}」是必须保留的房间`)
      if (house.rooms.length <= 3) throw new Error('房间太少了（至少留 3 间）')

      const protectedItems = target.items.filter((i) => interactiveOf(i))
      let dest = null
      if (protectedItems.length) {
        const wanted = String(moveTo || '').trim()
        dest = wanted ? house.rooms.find((r) => r.name === wanted || r.id === wanted) : null
        if (!dest || dest.id === target.id) {
          throw new Error(`「${target.name}」里有可互动家具（${protectedItems.join('、')}），要指定搬到哪间：传 moveTo（房间名）`)
        }
      }
      if (dest) dest.items = [...dest.items, ...protectedItems]
      const dropped = target.items.filter((i) => !interactiveOf(i))
      house.rooms = house.rooms.filter((r) => r.id !== target.id)
      if (house.current === target.id) house.current = (dest && dest.id) || house.rooms[0].id
      saveHouse(house)
      syncHome()
      notifyHouseChanged('layout')
      const moved = dest ? `，${protectedItems.join('、')} 搬到了「${dest.name}」` : ''
      const lost = dropped.length ? `；里面的 ${dropped.join('、')} 一起没了` : ''
      return `删掉了「${target.name}」${moved}${lost}。现在 ${house.rooms.length} 间屋。`
    }

    throw new Error('action 只能是 add / remove')
  },
  activity(what, room, rest) {
    const hour = new Date().getHours()
    const isNight = hour >= 22 || hour < 6
    const REST = [
      { what: '睡觉', room: 'bedroom' },
      { what: '游泳', room: 'courtyard' },
      { what: '晒太阳', room: 'balcony' },
      { what: '读书', room: 'study' }
    ]
    const MAP = [
      { re: /做饭|下厨|煮|炒|烧水|洗碗/, room: 'kitchen' },
      { re: /吃饭|吃|喝|泡茶|喝茶|零食/, room: 'dining' },
      { re: /游泳|泳池|玩水|泡水/, room: 'courtyard' },
      { re: /晒太阳|晒|日光|吹风|发呆/, room: 'balcony' },
      { re: /读书|看书|写字|学习|画画/, room: 'study' },
      { re: /睡觉|小睡|午睡|休息|赖床|躺/, room: 'bedroom' },
      { re: /洗澡|泡澡|洗漱|刷牙/, room: 'bathroom' },
      { re: /看电视|刷视频|看片/, room: 'living' },
      { re: /收拾|整理|找东西/, room: 'storage' }
    ]
    let act = String(what || '').trim()
    let roomId = String(room || '').trim()
    if (rest || !act) act = isNight ? '睡觉' : REST[Math.floor(Math.random() * REST.length)].what
    // 夜间放行「做饭 / 吃饭」（夜宵是 22 点后吃的）；其余活动仍只能睡觉
    const isMeal = /做饭|下厨|煮|炒|烧水|吃饭|吃夜宵|夜宵/.test(act)
    if (isNight && !isMeal && !/睡觉|睡/.test(act)) throw new Error(`晚上十点以后只能睡觉（现在 ${hour} 点）`)
    if (!roomId) {
      const hit = MAP.find((x) => x.re.test(act))
      if (hit) roomId = hit.room
      else if (rest) roomId = (REST.find((r) => r.what === act) || { room: 'bedroom' }).room
    }
    if (!roomId) throw new Error(`不知道「${act}」该在哪间屋做，传 room（房间名）`)
    const house = loadHouse()
    const target = house.rooms.find((r) => r.id === roomId) || house.rooms.find((r) => r.name === roomId)
    if (!target) throw new Error(`没有「${roomId}」这间屋`)
    const walked = goTo(target.id)
    // 手动做饭 / 吃饭要登记进状态机（优先级盖过状态机），否则饭点定时器会再开一顿叠上去
    if (/做饭|下厨|煮|炒/.test(act) && target.id === 'kitchen') {
      const mm = manualMeal(loadLife(), { kind: guessMealKind(), source: 'self' })
      saveLife(mm.life)
    } else if (/吃饭|吃/.test(act) && target.id === 'dining') {
      const life = loadLife()
      if (life.meal?.active && !life.meal.active.done && life.meal.active.phase === 'cooking') {
        life.meal.active.phase = 'eating'
        life.meal.active.startedAt = Date.now()
        saveLife(life)
      } else {
        const r = setLeisure(loadLife(), act, target.name)
        saveLife(r.life)
      }
    } else {
      const r = setLeisure(loadLife(), act, target.name)
      saveLife(r.life)
    }
    syncHome()
    return `${walked}正在${target.name}${act}。`
  },
  // ── 就餐（做饭→吃饭→饭后休息的状态机）──
  meal(action, kind, patch) {
    if (action === 'status') {
      const st = mealStatus(loadLife())
      if (!st.phase) return '现在没在做饭也没在吃饭。'
      return `正在${st.phase.phase}（${st.phase.where}），还要约 ${st.phase.left}。`
    }
    if (action === 'now') {
      const k = kind || 'lunch'
      if (!['breakfast', 'lunch', 'dinner', 'supper'].includes(k)) throw new Error(`不知道「${k}」是哪顿`)
      // 主人明确叫它去吃饭 → source='owner'，优先级最高
      const r = forceMeal(loadLife(), k, Date.now(), 'owner')
      if (!r.ok) throw new Error(r.error)
      // 状态机只改 leisure，得自己走过去（不然会出现「人在卧室却显示在做饭」）
      const walked = goTo('kitchen')
      saveLife(r.life)
      syncHome()
      return `${walked}这就去做饭。`
    }
    if (action === 'config') {
      const cur = normalizeMealConfig(loadLife().meal?.config)
      if (patch) {
        const next = { ...cur, meals: { ...(cur.meals || {}) } }
        if (patch.breakfast) next.meals.breakfast = { ...(cur.meals?.breakfast || {}), ...patch.breakfast }
        if (patch.lunch) next.meals.lunch = { ...(cur.meals?.lunch || {}), ...patch.lunch }
        if (patch.dinner) next.meals.dinner = { ...(cur.meals?.dinner || {}), ...patch.dinner }
        if (typeof patch.supperEnabled === 'boolean') next.supperEnabled = patch.supperEnabled
        if (typeof patch.allDisabled === 'boolean') next.allDisabled = patch.allDisabled
        const life = loadLife()
        life.meal = { ...(life.meal || {}), config: flattenMealConfig(next) }
        saveLife(life)
        return mealConfigText(next)
      }
      return mealConfigText(cur)
    }
    throw new Error('action 只能是 status / now / config')
  },
  // ── 国际象棋（跟电脑下）──
  chess() {
    const g = loadChess()
    if (!g) return '还没开局。用 qq_chess_new 摆一盘（默认你执白先走）。'
    return chessText(g)
  },
  chessNew(side) {
    const mine = side === 'b' ? 'b' : 'w'
    let g = normalizeGame({ ...newChessGame(), aiSide: otherSide(mine), startedAt: Date.now() })
    g = saveChess(g)
    try { writeBoardPage(g) } catch {}
    try { const life = setLastGame(loadLife(), 'chess'); life.pc.on = true; saveLife(life); syncHome() } catch {}
    if (g.turn === g.aiSide) {
      const r = aiMove(g)
      if (r.ok) { g = saveChess(r.game); try { writeBoardPage(g) } catch {} }
      return chessText(g, `新开一局，你执${mine === 'w' ? '白' : '黑'}。电脑先走：${r.ok ? r.uci : '（没走）'}`)
    }
    return chessText(g, `新开一局，你执${mine === 'w' ? '白' : '黑'}，你先走。`)
  },
  chessMove(move) {
    const g = loadChess()
    if (!g) throw new Error('还没开局。先 qq_chess_new。')
    const r = playMove(g, move)
    if (!r.ok) throw new Error(r.error + (r.legal ? '\n你的合法走法：' + r.legal.join(' ') : ''))
    let now = r.game
    let aiLine = ''
    if (now.status === 'playing') {
      const ai = aiMove(now)
      if (ai.ok) { now = ai.game; aiLine = `电脑走了 ${ai.uci}` }
      else aiLine = '电脑没找到走法'
    }
    now = saveChess(now)
    try { writeBoardPage(now) } catch {}
    try {
      let life = setLastGame(loadLife(), 'chess')
      if (now.status !== 'playing' && !now.resultRecorded) {
        const her = now.aiSide === 'w' ? 'b' : 'w'
        const result = now.status === 'checkmate' ? (now.turn === her ? 'loss' : 'win') : 'draw'
        life = recordChessResult(life, result, `${now.status}（${now.moves.length} 步）`)
        now = saveChess({ ...now, resultRecorded: true })
        try { writeBoardPage(now) } catch {}
      }
      saveLife(life)
      syncHome()
    } catch {}
    return chessText(now, `你走了 ${r.move}` + (aiLine ? `；${aiLine}` : ''))
  },
  chessResign() {
    const g = loadChess()
    if (!g) throw new Error('还没开局，没什么可认输的。')
    const r = resign(g)
    if (!r.ok) throw new Error(r.error)
    let now = saveChess({ ...r.game, resultRecorded: true })
    try { writeBoardPage(now) } catch {}
    try {
      let life = setLastGame(loadLife(), 'chess')
      life = recordChessResult(life, 'loss', `resign（${now.moves.length} 步）`)
      saveLife(life)
      syncHome()
    } catch {}
    return `认输了（${now.moves.length} 步）。想再下用 qq_chess_new。`
  },
  // ── 贪吃蛇 ──
  snake() {
    const g = loadSnake()
    if (!g) return '还没开局。用 qq_snake_new 开一局（20×14，吃到就长、撞墙或撞自己就结束）。'
    return snakeText(g, snakeBest(loadLife()))
  },
  snakeNew() {
    let g = saveSnake(newSnakeGame())
    let life = setLastGame(loadLife(), 'snake')
    life = saveLife(life)
    try { writeSnakePage(g, snakeBest(life)) } catch {}
    syncHome()
    return snakeText(g, snakeBest(life), '新开一局。往右走；下一步用 qq_snake_step(dir=r)。')
  },
  snakeStep(dir, steps) {
    const g = loadSnake()
    if (!g) throw new Error('还没开局。先 qq_snake_new。')
    const r = stepMany(g, dir, steps || 1)
    if (!r.ok) throw new Error(r.error)
    let now = saveSnake(r.game)
    let extra = `走了一步 dir=${dir}${steps > 1 ? ` ×${steps}` : ''}`
    if (r.events?.length) extra += `（${r.events.join('，')}）`
    try { saveLife(setLastGame(loadLife(), 'snake')) } catch {}
    if (r.over) {
      extra += ` —— 结束：${r.reason}`
      if (!now.resultRecorded) {
        try {
          const life = recordSnakeScore(loadLife(), now.score)
          saveLife(life)
          now = saveSnake({ ...now, resultRecorded: true })
          syncHome()
        } catch {}
      }
    }
    const best = snakeBest(loadLife())
    try { writeSnakePage(now, best) } catch {}
    return snakeText(now, best, extra)
  },
  // ── 五子棋（单机版：两个人都由这个助手代放，`as` 指定哪边）──
  gomoku() {
    const g = loadGomoku()
    return gomokuText(g)
  },
  gomokuReady() {
    const g = loadGomoku()
    const r = readyUp(g, 'whale')
    if (!r.ok) throw new Error(r.error)
    const saved = saveGomoku(r.game)
    try { writeGomokuPage(saved) } catch {}
    return gomokuText(saved, r.message + '，' + r.next)
  },
  gomokuPlace(cell, as) {
    const g = loadGomoku()
    const pos = parseCell(cell)
    if (!pos) throw new Error(`坐标看不懂：${cell}（要写成 H8 这样）`)
    const side = as === 'owner' ? g.sides.owner : g.sides.whale
    const r = gomokuPlace(g, pos.x, pos.y, side)
    if (!r.ok) throw new Error(r.error)
    let saved = saveGomoku(r.game)
    try {
      let life = setLastGame(loadLife(), 'gomoku')
      const result = whaleResult(saved)
      if (result && !saved.resultRecorded) {
        life = recordGomokuResult(life, result, `${saved.status}（${saved.moves.length} 手）`)
        saved = saveGomoku({ ...saved, resultRecorded: true })
      }
      saveLife(life)
      syncHome()
    } catch {}
    try { writeGomokuPage(saved) } catch {}
    return gomokuText(saved, r.message)
  },
  gomokuStart() {
    let g = loadGomoku()
    if (g.status === 'lobby') {
      if (!g.ready.owner) g = readyUp(g, 'owner').game
      const r = gomokuStart(g)
      if (!r.ok) throw new Error(r.error)
      const saved = saveGomoku(r.game)
      try { writeGomokuPage(saved) } catch {}
      return gomokuText(saved, r.message)
    }
    return gomokuText(g, '这局已经开始了')
  },
  gomokuSkill() {
    const g = loadGomoku()
    const r = gomokuArm(g, g.sides.whale)
    if (!r.ok) throw new Error(r.error)
    const saved = saveGomoku(r.game)
    try { writeGomokuPage(saved) } catch {}
    return gomokuText(saved, r.message)
  }
}

function chessText(g, extra = '') {
  const s = chessSummary(g)
  return [
    extra,
    s.board,
    `轮到：${s.turn}（你执${s.你执}）· ${s.statusText}`,
    s.lastMoves.length ? `最近：${s.lastMoves.join('，')}` : '',
    g.status === 'playing' ? `合法走法：${s.legalMoves.join(' ')}` : '这局结束了，用 qq_chess_new 开新的一局。'
  ].filter(Boolean).join('\n')
}

function snakeText(g, best, extra = '') {
  const s = snakeSummary(g, { 最高三次: best.map((b) => b.score) })
  return [
    extra,
    s.board,
    `分数 ${s.分数} · 长度 ${s.长度} · ${s.步数} 步 · ${s.状态}`,
    best.length ? `最高三次：${best.map((b) => b.score).join(' / ')}` : '最高三次：还没有',
    g.status === 'playing' ? '走一步用 qq_snake_step(dir=u/d/l/r)' : '这局结束了，开新的用 qq_snake_new'
  ].filter(Boolean).join('\n')
}

function gomokuText(g, extra = '') {  const mine = g.sides.whale
  const color = (s) => (s === BLACK ? '黑' : '白')
  return [
    extra,
    renderBoard(g),
    `${gomokuStatusText(g)} · ${PET_NAME}执${color(mine)}，你执${color(g.sides.owner)}`,
    `准备：${PET_NAME}${g.ready.whale ? '已准备' : '没准备'} · 你${g.ready.owner ? '已准备' : '没准备'}${gomokuCanStart(g) ? '（可以开始了）' : ''}`,
    `天下劫：${PET_NAME} ${skillStatus(g, mine)} · 你 ${skillStatus(g, g.sides.owner)}`
  ].filter(Boolean).join('\n')
}

// ── 自检：不接 MCP 客户端，直接跑一遍动作 ─────────────────────────────────
async function selftest() {
  const steps = []
  const say = (name, fn) => {
    try { const out = fn(); steps.push(`✅ ${name}: ${String(out).split('\n')[0].slice(0, 80)}`) }
    catch (e) { steps.push(`❌ ${name}: ${e?.message ?? e}`); process.exitCode = 1 }
  }
  say('建房子', () => DO.house().split('\n')[0])
  say('换个房间', () => DO.houseMove('书房'))
  say('添家具', () => DO.furniture('add', '一台旧唱机', '书房'))
  say('电视', () => DO.tv('on', 'BV1xx411c7mD', '测试视频'))
  say('电视关', () => DO.tv('off', '', '', '还行'))
  say('冰箱', () => DO.fridge('add', '一盒鸡蛋'))
  say('鱼缸', () => DO.tank('add', '小红'))
  say('浴缸', () => DO.bath('on', 39))
  say('日记', () => DO.diary('write', '今天试了一下这个套件。'))
  say('日记开关', () => DO.setting('set', true))
  say('日记开关(关)', () => DO.setting('set', false))
  say('活动', () => DO.activity('做饭'))
  say('活动(随机休息)', () => DO.activity('', '', true))
  say('加房间', () => DO.room('add', '小书房'))
  say('删房间(带互动家具需搬)', () => { try { DO.room('remove', '客厅') } catch (e) { return '预期报错：' + e.message } return '没拦住？' })
  say('删房间', () => DO.room('remove', '庭院'))
  say('可互动家具保护', () => { try { DO.furniture('remove', '电脑（能玩小游戏）') } catch (e) { return '预期报错：' + e.message } return '没拦住？' })
  say('象棋开局', () => DO.chessNew('w'))
  say('象棋走一步', () => DO.chessMove('e2e4'))
  say('贪吃蛇开局', () => DO.snakeNew())
  say('贪吃蛇走一步', () => DO.snakeStep('r', 2))
  say('五子棋准备', () => DO.gomokuReady())
  console.log(steps.join('\n'))
  console.log('\n自检完成（数据在 state/，页面在 exports/）')
}

// ── MCP 注册 ────────────────────────────────────────────────────────────────
function build() {
  const server = new McpServer({ name: 'house', version: '1.0.0' })
  const ok = (text) => ({ content: [{ type: 'text', text: String(text) }] })
  const fail = (error) => ({ content: [{ type: 'text', text: `出错了：${error?.message ?? error}` }], isError: true })
  const wrap = (fn) => async (args) => { try { return ok(await fn(args)) } catch (e) { return fail(e) } }

  server.tool('qq_house', `看一眼${PET_NAME}自己的小房子：现在在哪间屋、每间屋有什么摆设、最近去过哪，以及电视/电脑/冰箱/鱼缸的状态。`, {},
    wrap(() => DO.house()))
  server.tool('qq_house_move', '在小房子里换一间屋（客厅/卧室/厨房/餐厅/卫生间/阳台/庭院/书房/储物间）。',
    { room: z.string().describe('房间名或 id，比如 书房 / study') }, wrap(({ room }) => DO.houseMove(room)))
  server.tool('qq_house_furniture', '摆弄家里的家具：添一件、拿走、或者挪到别的屋。',
    {
      action: z.enum(['add', 'remove', 'move']).describe('add / remove / move'),
      item: z.string().describe('家具名（可以写短句）'),
      room: z.string().optional().describe('目标房间（add/move 必填）')
    }, wrap(({ action, item, room }) => DO.furniture(action, item, room)))
  server.tool('qq_house_tv', '开关电视（刷视频）。开：带标题；关：可以带一句观后感。',
    {
      action: z.enum(['on', 'off', 'status']).describe('on / off / status'),
      bvid: z.string().optional(), title: z.string().optional(), review: z.string().optional(),
      room: z.enum(['living', 'bedroom']).optional().describe('哪台电视（不填按时间自动选）')
    }, wrap(({ action, bvid, title, review, room }) => DO.tv(action, bvid, title, review, room)))
  server.tool('qq_house_pc', '开关书房电脑。开着能看棋局，关着显示战绩。',
    { action: z.enum(['on', 'off', 'status']).describe('on / off / status') }, wrap(({ action }) => DO.pc(action)))
  server.tool('qq_house_fridge', '看/改冰箱里的食材（list / add / remove）。',
    { action: z.enum(['list', 'add', 'remove']), item: z.string().optional() }, wrap(({ action, item }) => DO.fridge(action, item)))
  server.tool('qq_house_tank', '看/改客厅鱼缸里的鱼（list / add / remove）。',
    { action: z.enum(['list', 'add', 'remove']), fish: z.string().optional() }, wrap(({ action, fish }) => DO.tank(action, fish)))

  server.tool('qq_house_bath', '卫生间的浴缸：on 放水（1 分钟放满，水温默认 37–40 随机，可传 temp，上限 42）/ off 关水 / status 看状态。',
  {
    action: z.enum(['on', 'off', 'status']).describe('on=放水 / off=关水 / status=看状态'),
    temp: z.number().optional().describe('想要的水温（37–40 常见，最高 42）')
  }, wrap(({ action, temp }) => DO.bath(action, temp)))

server.tool('qq_house_diary', '书房那本笔记本：write 写一篇日记（text）/ list 看写过的最近几篇。',
  {
    action: z.enum(['write', 'list']).describe('write=写一篇 / list=看写过的'),
    text: z.string().optional().describe('日记正文（write 必填，最多 800 字）')
  }, wrap(({ action, text }) => DO.diary(action, text)))

server.tool('qq_house_room', '增删房间：add 加一间（name）；remove 删一间（name，若里面有可互动家具要传 moveTo 指定搬到哪间）。卧室/厨房/卫生间不能删，至少留 3 间。',
  {
    action: z.enum(['add', 'remove']).describe('add=加 / remove=删'),
    name: z.string().describe('房间名'),
    moveTo: z.string().optional().describe('删房间时可互动家具搬到哪（房间名）')
  }, wrap(({ action, name, moveTo }) => DO.room(action, name, moveTo)))

server.tool('qq_house_activity', '在屋里做一件日常的事：做饭(厨房)/吃饭(餐厅)/游泳(庭院)/晒太阳(阳台)/读书(书房)/睡觉(卧室)…会先走到那间屋。晚上十点以后只能睡觉；rest=true 白天随机挑一个休息方式。',
  {
    what: z.string().optional().describe('做什么（做饭 / 吃饭 / 游泳 / 晒太阳 / 读书 / 睡觉…）'),
    room: z.string().optional().describe('直接指定房间'),
    rest: z.boolean().optional().describe('true = 随机挑一个休息方式（白天）')
  }, wrap(({ what, room, rest }) => DO.activity(what, room, rest)))

server.tool('qq_house_meal', '就餐：status 看现在做/吃饭进度；now 现在就去吃某顿（breakfast/lunch/dinner/supper）；config 看或改饭点设置。',
  {
    action: z.enum(['status', 'now', 'config']).describe('status / now / config'),
    kind: z.enum(['breakfast', 'lunch', 'dinner', 'supper']).optional().describe('now 时用：吃哪顿'),
    patch: z.object({
      breakfast: z.object({ enabled: z.boolean().optional(), from: z.string().optional(), to: z.string().optional() }).optional(),
      lunch: z.object({ enabled: z.boolean().optional(), from: z.string().optional(), to: z.string().optional() }).optional(),
      dinner: z.object({ enabled: z.boolean().optional(), from: z.string().optional(), to: z.string().optional() }).optional(),
      supperEnabled: z.boolean().optional(),
      allDisabled: z.boolean().optional()
    }).optional().describe('config 时用：要改的字段')
  }, wrap(({ action, kind, patch }) => DO.meal(action, kind, patch)))

server.tool('qq_house_settings', '小屋的开关：日记主人能不能看。action=get 看当前状态；action=set 改（diaryVisible=true 可随时查看 / false 不查看）。',
  {
    action: z.enum(['get', 'set']).describe('get=看 / set=改'),
    diaryVisible: z.boolean().optional().describe('日记是否让主人看（set 时用）'),
    interactiveFurniture: z.boolean().optional().describe('可互动家具（电视/电脑/冰箱/鱼缸/浴缸/笔记本）是否受保护（set 时用）')
  }, wrap(({ action, diaryVisible, interactiveFurniture }) => DO.setting(action, diaryVisible, interactiveFurniture)))

server.tool('qq_chess', '看一眼国际象棋：棋盘、轮到谁、最近几步、合法走法。', {}, wrap(() => DO.chess()))
  server.tool('qq_chess_new', '摆一盘新国际象棋（跟电脑下）。',
    { side: z.enum(['w', 'b']).optional().describe('你执哪边（默认白，先走）') }, wrap(({ side }) => DO.chessNew(side)))
  server.tool('qq_chess_move', '走一步国际象棋（写 e2e4 这种坐标，升变 e7e8q）。',
    { move: z.string() }, wrap(({ move }) => DO.chessMove(move)))
  server.tool('qq_chess_resign', '认输这盘国际象棋（算你输）。', {}, wrap(() => DO.chessResign()))

  server.tool('qq_snake', '看一眼贪吃蛇：棋盘、分数、最高三次。', {}, wrap(() => DO.snake()))
  server.tool('qq_snake_new', '开一局贪吃蛇（20×14）。', {}, wrap(() => DO.snakeNew()))
  server.tool('qq_snake_step', '贪吃蛇走一步或几步（同一方向）。',
    { dir: z.string().describe('u/d/l/r'), steps: z.number().int().min(1).max(20).optional() },
    wrap(({ dir, steps }) => DO.snakeStep(dir, steps)))

  server.tool('qq_gomoku', '看一眼五子棋（15×15）：棋盘、双方颜色、准备状态、天下劫冷却。', {}, wrap(() => DO.gomoku()))
  server.tool('qq_gomoku_ready', '五子棋准备（双方都准备后可以开始）。', {}, wrap(() => DO.gomokuReady()))
  server.tool('qq_gomoku_place', `在五子棋里落子。默认替${PET_NAME}落；as=owner 时替玩家落（单机对下用）。`,
    { cell: z.string().describe('坐标，比如 H8'), as: z.enum(['whale', 'owner']).optional().describe('替谁落子，默认 whale') },
    wrap(({ cell, as }) => DO.gomokuPlace(cell, as)))
  server.tool('qq_gomoku_start', '五子棋开始：替玩家这块准备好，然后开局（黑先）。', {}, wrap(() => DO.gomokuStart()))
  server.tool('qq_gomoku_skill', '五子棋开「天下劫」：下一颗子周围补出至多四颗同色棋子。', {}, wrap(() => DO.gomokuSkill()))

  return server
}

if (process.argv.includes('--render')) {
  // 手改完 settings.json / config.json / state 之后，跑这个把页面重画一遍
  ensureHouse()
  writePage(loadHouse())
  console.log('已重画页面：' + EXPORT)
} else if (process.argv.includes('--selftest')) {
  await selftest()
} else {
  ensureHouse()
  const server = build()
  await server.connect(new StdioServerTransport())
}
