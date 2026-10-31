// 服务器版的小屋控制台：一个本地 HTTP 服务
//
//   node src/ui.mjs            → 打开 http://127.0.0.1:3210/ 就是小屋页面，
//                                右下角有「设置」按钮（名字 / 开关 / 房间 / 家具）
//
// 只依赖 node:http，不装额外东西；数据直接读写 state/*.json 和 settings.json，
// 改完立刻重画页面。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PET_NAME, petTitle } from './who.mjs'
import { readQqConfig, writeQqConfig } from './qqshot.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const STATE = path.join(ROOT, 'state')
const EXPORT = path.join(ROOT, 'exports')
const SETTINGS_FILE = path.join(ROOT, 'settings.json')
const HOUSE_FILE = path.join(STATE, 'house.json')
const LIFE_FILE = path.join(STATE, 'home-life.json')
const PORT = Number(process.env.WHALEHOUSE_PORT || JSON.parse(readSafe(SETTINGS_FILE, '{}'))?.uiPort || 3210)

// 就餐配置默认值（跟 core/meal.mjs 的 DEFAULT_MEALS 一致）：
// 盘里只存了 enabled 没存 from/to 时补默认饭点，否则 UI 会显示 00:00。
const DEFAULT_MEAL_SPANS = {
  breakfast: { from: 7 * 60, to: 9 * 60 },
  lunch: { from: 11 * 60, to: 13 * 60 },
  dinner: { from: 17 * 60, to: 19 * 60 }
}
function mealConfigWithDefaults(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const src = g.meals && typeof g.meals === 'object' ? g.meals : g
  const out = {}
  for (const key of ['breakfast', 'lunch', 'dinner']) {
    const m = src[key] && typeof src[key] === 'object' ? src[key] : {}
    const d = DEFAULT_MEAL_SPANS[key]
    out[key] = {
      enabled: m.enabled !== false,
      from: Number.isFinite(Number(m.from)) ? Number(m.from) : d.from,
      to: Number.isFinite(Number(m.to)) ? Number(m.to) : d.to
    }
  }
  out.supperEnabled = g.supperEnabled !== false
  out.supperChance = Number.isFinite(Number(g.supperChance)) ? Number(g.supperChance) : 0.3
  out.allDisabled = g.allDisabled === true
  return out
}

// 控制台模式下重画页面时，标题右边加一个「设置」按钮（静态导出的 HTML 不加）
let houseModRef = null
const rerenderWithButton = async () => {
  if (!houseModRef) return
  const h = houseModRef.loadHouse()
  fs.mkdirSync(EXPORT, { recursive: true })
  // 先让 house.mjs 正常画（图鉴、日记、房子页都写好），再用带按钮的版本覆盖房子页
  try { houseModRef.writePage(h) } catch { /* 图鉴/日记画不出来不影响 */ }
  let life = null
  try {
    const lifeMod = await import(pathToFileURL(path.join(__dirname, 'home-life.mjs')).href)
    life = lifeMod.loadLife()
  } catch { /* 拿不到就算了 */ }
  const html = houseModRef.renderPage(h, life, null, { withSettingsButton: true })
  fs.writeFileSync(houseModRef.pageFile(), html, 'utf8')
}

// 包里可能没有 state/ 和 exports/（空目录不进 zip），启动时先建好
fs.mkdirSync(STATE, { recursive: true })
fs.mkdirSync(EXPORT, { recursive: true })

const houseMod = await import(pathToFileURL(path.join(__dirname, 'house.mjs')).href)

const PROTECTED = [
  { kind: 'tv', word: '电视' },
  { kind: 'pc', word: '电脑' },
  { kind: 'fridge', word: '冰箱' },
  { kind: 'tank', word: '鱼缸' },
  { kind: 'bath', word: '浴缸' },
  { kind: 'diary', word: '笔记本' }
]
const MUST_KEEP = ['卧室', '厨房', '卫生间']

function readSafe(file, fallback) {
  try { return fs.readFileSync(file, 'utf8') } catch { return fallback }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(readSafe(file, 'null')) ?? fallback } catch { return fallback }
}
function readSettings() {
  const s = readJson(SETTINGS_FILE, {})
  return { diaryVisible: s?.diaryVisible === true, interactiveFurniture: s?.interactiveFurniture !== false, uiPort: Number(s?.uiPort) || 3210 }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) }
  const clean = { diaryVisible: next.diaryVisible === true, interactiveFurniture: next.interactiveFurniture !== false, uiPort: Number(next.uiPort) || 3210 }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}
const kindOf = (item) => PROTECTED.find((p) => String(item).includes(p.word)) || null
const tvTotal = (house) => house.rooms.reduce((n, r) => n + r.items.filter((i) => i.includes('电视')).length, 0)
// 重画：房子页带「设置」按钮（控制台专用），图鉴/日记照常
const rerender = () => { void rerenderWithButton().catch(() => { try { houseMod.writePage(houseMod.loadHouse()) } catch { /* ignore */ } }) }
houseModRef = houseMod

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function html(res, text) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}
const findPage = (suffix) => {
  try {
    const hits = fs.readdirSync(EXPORT).filter((f) => f.endsWith(suffix + '.html')).map((f) => ({ f, m: fs.statSync(path.join(EXPORT, f)).mtimeMs })).sort((a, b) => b.m - a.m)
    return hits.length ? path.join(EXPORT, hits[0].f) : null
  } catch { return null }
}

const PAGES = { '/': '小房子', '/catalogue': '家具图鉴', '/chess': '棋局', '/snake': '贪吃蛇', '/gomoku': '五子棋', '/diary': '日记' }
const inject = (text) => text.includes('</body>')
  ? text.replace('</body>', '<script src="/ui.js"></script>\n</body>')
  : text + '\n<script src="/ui.js"></script>'

// 启动时兜底：没有 house.json 就按普通小屋建一栋；没有页面就画一次
try {
  if (!fs.existsSync(HOUSE_FILE)) {
    const mod = await import(pathToFileURL(path.join(__dirname, 'house.mjs')).href)
    const style = mod.HOUSE_STYLES.plain
    mod.saveHouse({
      name: petTitle('小房子'),
      owner: PET_NAME,
      style: 'plain',
      current: style.rooms[0].id,
      movedAt: 0,
      rooms: style.rooms.map((r) => ({ ...r, items: [...r.items] })),
      log: [],
      history: []
    })
  }
  // 启动时先画一次带按钮的版本（页面可能已经存在，是上次跑留下的没按钮版本）
  await rerenderWithButton()
  // 小游戏页面：没有就开一局再画（否则 /chess /snake /gomoku 全是 404）
  try {
    const chess = await import(pathToFileURL(path.join(__dirname, 'chess.mjs')).href)
    const snake = await import(pathToFileURL(path.join(__dirname, 'snake.mjs')).href)
    const gomoku = await import(pathToFileURL(path.join(__dirname, 'gomoku.mjs')).href)
    try { chess.writeBoardPage(chess.loadGame() || chess.saveGame(chess.newGame())) } catch { /* 画不出来就算了 */ }
    try { snake.writePage(snake.loadSnake() || snake.saveSnake(snake.newGame()), []) } catch { /* 同上 */ }
    try { gomoku.writePage(gomoku.loadOrCreate()) } catch { /* 同上 */ }
  } catch { /* 没这几个模块就算了 */ }
} catch (e) {
  console.error('初始化失败：' + (e && e.message || e))
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (error) {
    try { json(res, { ok: false, error: String(error && error.message || error) }, 500) } catch { /* ignore */ }
  }
})

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  // 静态：控制面板脚本
  if (p === '/ui.js') {
    try {
      const js = fs.readFileSync(path.join(__dirname, 'ui-client.js'), 'utf8')
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(js)
    } catch {
      res.writeHead(404); res.end('ui-client.js 缺失')
    }
    return
  }

  // 页面
  if (req.method === 'GET' && PAGES[p]) {
    const file = findPage(PAGES[p])
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`还没有「${PAGES[p]}」页面`); return }
    // 页面自己会定时查 /api/page-signature，变了就整页刷新（不用人手动 F5）
    html(res, inject(fs.readFileSync(file, 'utf8')))
    return
  }

  // 页面指纹：给前端轮询用（房子/家电/日记任一变了，签名就变）
  if (p === '/api/page-signature') {
    try {
      const files = fs.readdirSync(EXPORT).filter((f) => f.endsWith('.html'))
      const sig = files
        .map((f) => `${f}:${fs.statSync(path.join(EXPORT, f)).mtimeMs}:${fs.statSync(path.join(EXPORT, f)).size}`)
        .sort()
        .join('|')
      json(res, { ok: true, sig })
    } catch (error) {
      json(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
    return
  }

  // ── API ────────────────────────────────────────────────────────────────
  const body = await readBody(req)
  if (p === '/api/state') {
    const house = readJson(HOUSE_FILE, {})
    const life = readJson(LIFE_FILE, {})
    json(res, { ok: true, house: { name: house.name, owner: house.owner || '', current: house.current, rooms: house.rooms || [] }, settings: readSettings(), qq: readQqConfig(), meal: { config: mealConfigWithDefaults(life.meal?.config) }, mustKeep: MUST_KEEP, tvCount: tvTotal(house) })
    return
  }
  if (p === '/api/meal') {
    if (req.method === 'GET') {
      const life = readJson(LIFE_FILE, {})
      return json(res, { ok: true, meal: { config: mealConfigWithDefaults(life.meal?.config) } })
    }
    if (req.method === 'POST') {
      const life = readJson(LIFE_FILE, {}) || {}
      const cur = mealConfigWithDefaults(life.meal?.config)
      const patch = body.config || body
      if (patch.breakfast) cur.breakfast = { ...cur.breakfast, ...patch.breakfast }
      if (patch.lunch) cur.lunch = { ...cur.lunch, ...patch.lunch }
      if (patch.dinner) cur.dinner = { ...cur.dinner, ...patch.dinner }
      if (typeof patch.supperEnabled === 'boolean') cur.supperEnabled = patch.supperEnabled
      if (typeof patch.allDisabled === 'boolean') cur.allDisabled = patch.allDisabled
      life.meal = { ...(life.meal || {}), config: cur }
      fs.writeFileSync(LIFE_FILE, JSON.stringify(life, null, 2) + '\n', 'utf8')
      return json(res, { ok: true, meal: { config: cur } })
    }
    return json(res, { ok: false, error: '只接受 GET/POST' }, 405)
  }
  if (p === '/api/rename' && req.method === 'POST') {
    const house = houseMod.loadHouse()
    if (typeof body.owner === 'string' && body.owner.trim()) {
      const owner = body.owner.trim().slice(0, 20)
      const old = house.owner || ''
      house.owner = owner
      if (house.name === `${old}的小房子`) house.name = `${owner}的小房子`
    }
    if (typeof body.name === 'string' && body.name.trim()) house.name = body.name.trim().slice(0, 20)
    houseMod.saveHouse(house)
    rerender()
    json(res, { ok: true, name: house.name, owner: house.owner })
    return
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const patch = {}
    if (typeof body.diaryVisible === 'boolean') patch.diaryVisible = body.diaryVisible
    if (typeof body.interactiveFurniture === 'boolean') patch.interactiveFurniture = body.interactiveFurniture
    const next = writeSettings(patch)
    try {
      const prefsFile = path.join(STATE, 'house-prefs.json')
      const cur = readJson(prefsFile, {})
      fs.writeFileSync(prefsFile, JSON.stringify({ ...cur, diaryVisible: next.diaryVisible }, null, 2) + '\n', 'utf8')
    } catch { /* 同步失败不影响设置 */ }
    rerender()
    json(res, { ok: true, settings: next })
    return
  }
  if (p === '/api/qqshot') {
    if (req.method === 'GET') return json(res, { ok: true, qq: readQqConfig() })
    if (req.method === 'POST') {
      const patch = {}
      if (body.ownerQQ !== undefined) patch.ownerQQ = Number(body.ownerQQ) || 0
      if (typeof body.httpUrl === 'string') patch.httpUrl = body.httpUrl
      if (typeof body.accessToken === 'string') patch.accessToken = body.accessToken
      if (typeof body.notifyScreenshot === 'boolean') patch.notifyScreenshot = body.notifyScreenshot
      if (typeof body.notifyOnMove === 'boolean') patch.notifyOnMove = body.notifyOnMove
      if (typeof body.askScreenshot === 'boolean') patch.askScreenshot = body.askScreenshot
      const next = writeQqConfig(patch)
      return json(res, { ok: true, qq: next })
    }
    return json(res, { ok: false, error: '只接受 GET/POST' }, 405)
  }
  if (p.startsWith('/api/room/') && req.method === 'POST') {
    const house = houseMod.loadHouse()
    const action = p.split('/').pop()
    if (action === 'add') {
      const name = String(body.name || '').trim()
      if (!name) return json(res, { ok: false, error: '房间名不能为空' }, 400)
      if (name.length > 10) return json(res, { ok: false, error: '房间名太长（最多 10 字）' }, 400)
      if (house.rooms.some((r) => r.name === name)) return json(res, { ok: false, error: `已经有「${name}」了` }, 409)
      house.rooms.push({ id: 'room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), name, icon: '🏠', items: [], desc: '' })
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true })
    }
    const room = house.rooms.find((r) => r.id === String(body.id || '')) || house.rooms.find((r) => r.name === String(body.name || ''))
    if (!room) return json(res, { ok: false, error: '没有这个房间' }, 404)
    if (action === 'rename') {
      const name = String(body.name || '').trim()
      if (!name) return json(res, { ok: false, error: '房间名不能为空' }, 400)
      if (house.rooms.some((r) => r.id !== room.id && r.name === name)) return json(res, { ok: false, error: `已经有「${name}」了` }, 409)
      room.name = name
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true })
    }
    if (action === 'remove') {
      if (MUST_KEEP.includes(room.name)) return json(res, { ok: false, error: `「${room.name}」是必须保留的房间` }, 400)
      if (house.rooms.length <= 3) return json(res, { ok: false, error: '房间太少了（至少留 3 间）' }, 400)
      const keep = room.items.filter((i) => kindOf(i))
      let dest = null
      if (keep.length) {
        dest = house.rooms.find((r) => r.id === String(body.moveTo || '')) || house.rooms.find((r) => r.name === String(body.moveTo || ''))
        if (!dest || dest.id === room.id) {
          return json(res, {
            ok: false,
            needMove: true,
            error: `「${room.name}」里有可互动家具（${keep.join('、')}），先选一间屋把它们搬过去`,
            items: keep,
            candidates: house.rooms.filter((r) => r.id !== room.id).map((r) => ({ id: r.id, name: r.name }))
          }, 409)
        }
      }
      if (dest) dest.items = [...dest.items, ...keep]
      house.rooms = house.rooms.filter((r) => r.id !== room.id)
      if (house.current === room.id) house.current = (dest && dest.id) || house.rooms[0].id
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true, movedTo: dest ? dest.name : null })
    }
    return json(res, { ok: false, error: '未知的房间操作' }, 404)
  }
  if (p.startsWith('/api/item/') && req.method === 'POST') {
    const house = houseMod.loadHouse()
    const action = p.split('/').pop()
    const room = house.rooms.find((r) => r.id === String(body.roomId || ''))
    if (!room) return json(res, { ok: false, error: '没有这个房间' }, 404)
    const settings = readSettings()
    if (action === 'add') {
      const name = String(body.name || '').trim()
      if (!name) return json(res, { ok: false, error: '家具名不能为空' }, 400)
      if (room.items.includes(name)) return json(res, { ok: false, error: '这间屋里已经有同名的了' }, 409)
      room.items.push(name.slice(0, 30))
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true })
    }
    const from = String(body.from || '')
    const idx = room.items.indexOf(from)
    if (idx < 0) return json(res, { ok: false, error: '这件家具不在这个屋里' }, 404)
    if (action === 'rename') {
      const to = String(body.to || '').trim()
      if (!to) return json(res, { ok: false, error: '新名字不能为空' }, 400)
      if (room.items.includes(to)) return json(res, { ok: false, error: '这间屋里已经有同名的了' }, 409)
      const kind = kindOf(from)
      if (kind && !to.includes(kind.word)) return json(res, { ok: false, error: `「${from}」是可互动家具，改名要保留「${kind.word}」` }, 400)
      if (!kind && kindOf(to)) return json(res, { ok: false, error: `「${to}」听起来像可互动家具，换个名字吧` }, 400)
      room.items[idx] = to.slice(0, 30)
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true })
    }
    if (action === 'move') {
      const to = house.rooms.find((r) => r.id === String(body.toRoomId || '')) || house.rooms.find((r) => r.name === String(body.to || ''))
      if (!to) return json(res, { ok: false, error: '目标房间不存在' }, 404)
      if (to.id === room.id) return json(res, { ok: false, error: '目标房间就是当前房间' }, 400)
      if (to.items.includes(from)) return json(res, { ok: false, error: `「${to.name}」里已经有一件「${from}」了` }, 409)
      room.items.splice(idx, 1)
      to.items.push(from)
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true, from: room.name, to: to.name })
    }
    if (action === 'remove') {
      const kind = kindOf(from)
      if (kind && settings.interactiveFurniture) {
        if (kind.kind === 'tv') {
          if (tvTotal(house) <= 1) return json(res, { ok: false, error: '至少要留一台电视' }, 400)
        } else {
          return json(res, { ok: false, error: `「${from}」是可互动家具，不能删（可在设置里关掉保护）` }, 400)
        }
      }
      room.items.splice(idx, 1)
      houseMod.saveHouse(house); rerender()
      return json(res, { ok: true })
    }
    return json(res, { ok: false, error: '未知的家具操作' }, 404)
  }

  if (p === '/api/shutdown' && req.method === 'POST') {
    json(res, { ok: true })
    setTimeout(() => process.exit(0), 200)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('404')
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`WhaleHouse 控制台：http://127.0.0.1:${PORT}/`)
  console.log(`  页面目录：${EXPORT}`)
  console.log(`  数据目录：${STATE}`)
})
