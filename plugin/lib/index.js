// DSH 插件：小屋（宿主半边）
//
// 干四件事：
//   1. 把 exports/ 下那几个页面挂到 /dsh-house/*，设置页 iframe 直接看；
//   2. /dsh-house/status 返回房子状态摘要；
//   3. **高级设置**：改名、增删房间、增删家具（/dsh-house/api/*），写回 house.json 并重画页面；
//   4. 页面里的相对链接改写成 /dsh-house/*。
//
// 写文件时直接复用桥接那边的 house.mjs（loadHouse/saveHouse/writePage），保证跟助手看到的是同一份。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const name = 'house'
export const inject = ['webServer']

const PAGES = [
  { id: 'page', suffix: '小房子' },
  { id: 'catalogue', suffix: '家具图鉴' },
  { id: 'chess', suffix: '棋局' },
  { id: 'snake', suffix: '贪吃蛇' },
  { id: 'gomoku', suffix: '五子棋' },
  { id: 'diary', suffix: '日记' }
]

// 有状态栏的家具：电脑 / 冰箱 / 鱼缸 不能删；电视能删，但要留至少一台
const PROTECTED = [
  { kind: 'tv', word: '电视', match: /电视/, movable: true },
  { kind: 'pc', word: '电脑', match: /电脑/, movable: false },
  { kind: 'fridge', word: '冰箱', match: /冰箱/, movable: false },
  { kind: 'tank', word: '鱼缸', match: /鱼缸/, movable: false },
  { kind: 'bath', word: '浴缸', match: /浴缸/, movable: false },
  { kind: 'diary', word: '笔记本', match: /笔记本/, movable: false }
]
const MUST_KEEP = ['卧室', '厨房', '卫生间']

const kindOf = (item) => PROTECTED.find((p) => p.match.test(String(item))) || null
const tvCount = (house) => house.rooms.reduce((n, r) => n + r.items.filter((i) => /电视/.test(i)).length, 0)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function apply(ctx, config) {
  // dir 没配 / 配错时自动找：插件旁边如果有 server/（分享包解压后的结构），就用它
  const pickDir = () => {
    const wanted = String(config?.dir || '').trim()
    const candidates = []
    if (wanted) candidates.push(wanted)
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server')) // <包根>/plugin/../server
    for (const c of candidates) {
      const p = c.replace(/[\\/]+$/, '')
      try {
        if (p && fs.existsSync(path.join(p, 'state', 'house.json'))) return p
      } catch { /* 下一个 */ }
    }
    return candidates[0].replace(/[\\/]+$/, '')
  }
  const bridgeDir = pickDir()
  // 页面目录：桥接那套是 <dir>/../exports（页面在桥接外面），
  // 分享包里服务器是自包含的，页面在 <dir>/exports 里 —— 两个都认，谁有页用谁。
  const exportsDirs = [
    path.join(bridgeDir, 'exports'),
    path.resolve(bridgeDir, '..', 'exports')
  ]
  const stateDir = path.join(bridgeDir, 'state')
  const houseFile = path.join(stateDir, 'house.json')

  const chain = pathToFileURL(path.join(bridgeDir, 'src', 'house.mjs')).href
  let houseMod = null
  const loadHouseMod = async () => {
    if (!houseMod) houseMod = await import(chain)
    return houseMod
  }

  // 就餐配置的默认值（跟 core/meal.mjs 的 DEFAULT_MEALS 一致）：
  // 盘里如果只存了 enabled 没存 from/to，读出来要补默认饭点，否则 UI 会显示成 00:00。
  const DEFAULT_MEAL_SPANS = {
    breakfast: { from: 7 * 60, to: 9 * 60 },
    lunch: { from: 11 * 60, to: 13 * 60 },
    dinner: { from: 17 * 60, to: 19 * 60 }
  }
  const mealConfigWithDefaults = (raw) => {
    const g = raw && typeof raw === 'object' ? raw : {}
    const src = g.meals && typeof g.meals === 'object' ? g.meals : g
    const out = {}
    for (const key of ['breakfast', 'lunch', 'dinner']) {
      const m = src[key] && typeof src[key] === 'object' ? src[key] : {}
      const d = DEFAULT_MEAL_SPANS[key]
      const from = Number.isFinite(Number(m.from)) ? Number(m.from) : d.from
      const to = Number.isFinite(Number(m.to)) ? Number(m.to) : d.to
      out[key] = { enabled: m.enabled !== false, from, to }
    }
    out.supperEnabled = g.supperEnabled !== false
    out.supperChance = Number.isFinite(Number(g.supperChance)) ? Number(g.supperChance) : 0.3
    out.allDisabled = g.allDisabled === true
    return out
  }

  const readHouse = () => {
    const house = readJson(houseFile)
    if (!house || !Array.isArray(house.rooms)) throw new Error('读不到 house.json（检查插件配置里的 dir）')
    return house
  }

  const saveHouse = (house) => {
    fs.writeFileSync(houseFile, JSON.stringify(house, null, 2) + '\n', 'utf8')
  }

  const rerender = async () => {
    try {
      const mod = await loadHouseMod()
      mod.writePage(mod.loadHouse())
    } catch { /* 页面重画失败不影响设置保存 */ }
  }

  /** 找 exports 里最新的那个 "<名字><后缀>.html"。 */
  const findPage = (suffix) => {
    const hits = []
    for (const dir of exportsDirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(`${suffix}.html`)) continue
          const full = path.join(dir, f)
          hits.push({ full, m: fs.statSync(full).mtimeMs })
        }
      } catch { /* 这个目录不存在就跳过 */ }
    }
    hits.sort((a, b) => b.m - a.m)
    return hits.length ? hits[0].full : null
  }

  /** 页面之间的相对链接 → /dsh-house/* */
  const rewrite = (html) => html.replace(
    /href="([^"]*?)(小房子|家具图鉴|棋局|贪吃蛇|五子棋|日记)\.html"/g,
    (_m, _p, suffix) => {
      const hit = PAGES.find((p) => p.suffix === suffix)
      return hit ? `href="/dsh-house/${hit.id}"` : _m
    }
  )

  const sendHtml = (res, file, fallback) => {
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(fallback)
      return
    }
    try {
      const html = rewrite(fs.readFileSync(file, 'utf8'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('读取页面失败：' + String(error?.message ?? error))
    }
  }

  const sendJson = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const route = (kind, routePath, handler) => ctx.effect(() => ctx.webServer.register({
    kind,
    path: routePath,
    handler
  }))

  for (const page of PAGES) {
    route('exact', `/dsh-house/${page.id}`, async (req, res) => {
      sendHtml(res, findPage(page.suffix), `还没有生成「${page.suffix}」页面：让助手先调一次房子工具，或者检查插件配置里的 dir`)
    })
  }

  route('exact', '/dsh-house/status', async (req, res) => {
    const house = readJson(houseFile)
    const life = readJson(path.join(stateDir, 'home-life.json'))
    const chessGame = readJson(path.join(stateDir, 'chess.json'))
    const snakeGame = readJson(path.join(stateDir, 'snake.json'))
    const room = house?.rooms?.find((r) => r.id === house.current)
    const tv = life?.tv || {}
    sendJson(res, {
      ok: true,
      name: house?.name || '小屋',
      room: room?.name || '',
      rooms: house?.rooms?.length || 0,
      tv: Object.entries(tv).map(([key, v]) => ({
        room: key,
        on: v?.on === true,
        title: v?.now?.title || '',
        last: v?.last?.title || ''
      })),
      pc: life?.pc || {},
      fridge: life?.fridge?.items?.length || 0,
      tank: life?.tank?.fish?.length || 0,
      chess: life?.chess || {},
      gomoku: life?.gomoku || {},
      snake: life?.snake || {},
      // 会话栏的「小屋」tab 用它判断要不要重载 iframe（水量百分比会自己涨，不用重载）
      bath: {
        on: life?.bath?.on === true,
        startedAt: Number(life?.bath?.startedAt) || 0,
        temp: Number(life?.bath?.temp) || 0
      },
      diary: {
        count: Array.isArray(life?.diary?.entries) ? life.diary.entries.length : 0,
        lastAt: Number(life?.diary?.lastAt) || 0
      },
      // 棋局/贪吃蛇的「当前这一盘」签名：会话栏那几个 tab 靠它判断要不要重载
      live: {
        chess: chessGame
          ? { moves: (chessGame.moves || []).length, status: chessGame.status || '', turn: chessGame.turn || '', at: chessGame.updatedAt || 0 }
          : null,
        snake: snakeGame
          ? { score: snakeGame.score || 0, steps: snakeGame.steps || 0, status: snakeGame.status || '', at: snakeGame.updatedAt || 0 }
          : null
      }
    })
  })

  // ── 高级设置 ────────────────────────────────────────────────────────────
  // 助手改格局后要不要自动截图（跟桥接共用 state/house-prefs.json）
  const prefsFile = path.join(stateDir, 'house-prefs.json')
  const readPrefs = () => {
    const j = readJson(prefsFile)
    return {
      notifyScreenshot: j?.notifyScreenshot === true,
      notifyOnMove: j?.notifyOnMove === true,
      // 主人的日记能不能看（默认不看）
      diaryVisible: j?.diaryVisible === true,
      // 必留房间的 id 记在这里：房间改名/搬走后，「必留」跟着 id 走，不会因为换了名字就失守
      keepRoomIds: Array.isArray(j?.keepRoomIds) ? j.keepRoomIds.filter((x) => typeof x === 'string') : []
    }
  }
  const writePrefs = (patch) => {
    const next = { ...readPrefs(), ...(patch || {}) }
    const clean = {
      notifyScreenshot: next.notifyScreenshot === true,
      notifyOnMove: next.notifyOnMove === true,
      diaryVisible: next.diaryVisible === true,
      keepRoomIds: Array.isArray(next.keepRoomIds) ? next.keepRoomIds.filter((x) => typeof x === 'string') : []
    }
    fs.writeFileSync(prefsFile, JSON.stringify(clean, null, 2) + '\n', 'utf8')
    return clean
  }

  /** 必留房间的 id：优先用记下来的，没记过就按名字认一遍。 */
  const keepIdsOf = (house) => {
    const stored = readPrefs().keepRoomIds
    if (stored.length) return stored
    return house.rooms.filter((r) => MUST_KEEP.includes(r.name)).map((r) => r.id)
  }

  // ── 高级设置 ────────────────────────────────────────────────────────────
  const policy = (house) => {
    const keepIds = keepIdsOf(house)
    return {
      mustKeep: MUST_KEEP,
      keepIds,
      protected: PROTECTED.map((p) => ({ kind: p.kind, word: p.word, movable: p.movable })),
      tvCount: tvCount(house),
      rooms: house.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon || '🏠',
        items: r.items,
        isMustKeep: keepIds.includes(r.id),
        lockedItems: r.items.filter((i) => kindOf(i) && !kindOf(i).movable),
        tvItems: r.items.filter((i) => /电视/.test(i))
      }))
    }
  }

  route('exact', '/dsh-house/api/prefs', async (req, res) => {
    if (req.method === 'GET') return sendJson(res, { ok: true, ...readPrefs() })
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 GET/POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const patch = {}
      if (body.notifyScreenshot !== undefined) patch.notifyScreenshot = body.notifyScreenshot === true
      if (body.notifyOnMove !== undefined) patch.notifyOnMove = body.notifyOnMove === true
      if (body.diaryVisible !== undefined) patch.diaryVisible = body.diaryVisible !== false
      const next = writePrefs(patch)
      // 日记开关会改变房子页上的入口和日记页，改完重画一次
      if (body.diaryVisible !== undefined) await rerender()
      sendJson(res, { ok: true, ...next })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/meal', async (req, res) => {
    const lifeFile = path.join(stateDir, 'home-life.json')
    const readMeal = () => {
      const life = readJson(lifeFile) || {}
      return life.meal && typeof life.meal === 'object' ? life.meal : {}
    }
    const writeMeal = (meal) => {
      const life = readJson(lifeFile) || {}
      life.meal = meal
      fs.writeFileSync(lifeFile, JSON.stringify(life, null, 2) + '\n', 'utf8')
      return meal
    }
    if (req.method === 'GET') {
      const cur = readMeal()
      return sendJson(res, { ok: true, meal: { ...cur, config: mealConfigWithDefaults(cur.config) } })
    }
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 GET/POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const cur = readMeal()
      // 先补默认值再合并 patch，这样第一次保存也能存下完整饭点
      const config = mealConfigWithDefaults(cur.config)
      const patch = body.config || body
      if (patch.breakfast) config.breakfast = { ...config.breakfast, ...patch.breakfast }
      if (patch.lunch) config.lunch = { ...config.lunch, ...patch.lunch }
      if (patch.dinner) config.dinner = { ...config.dinner, ...patch.dinner }
      if (typeof patch.supperEnabled === 'boolean') config.supperEnabled = patch.supperEnabled
      if (typeof patch.allDisabled === 'boolean') config.allDisabled = patch.allDisabled
      const next = writeMeal({ ...cur, config })
      sendJson(res, { ok: true, meal: next })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/house', async (req, res) => {
    try {
      const house = readHouse()
      sendJson(res, {
        ok: true,
        house: { name: house.name, owner: house.owner || '', current: house.current, rooms: house.rooms },
        policy: policy(house),
        prefs: readPrefs()
      })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/rename', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const house = readHouse()
      if (body.owner !== undefined) {
        const owner = String(body.owner).trim()
        if (!owner) return sendJson(res, { ok: false, error: '名字不能为空' }, 400)
        if (owner.length > 20) return sendJson(res, { ok: false, error: '名字太长（最多 20 字）' }, 400)
        const oldOwner = house.owner || ''
        house.owner = owner
        // 小屋名字如果还是「<旧名字>的小房子」，跟着一起改
        if (house.name === `${oldOwner}的小房子`) house.name = `${owner}的小房子`
      }
      if (body.name !== undefined) {
        const name = String(body.name).trim()
        if (!name) return sendJson(res, { ok: false, error: '名字不能为空' }, 400)
        if (name.length > 20) return sendJson(res, { ok: false, error: '名字太长（最多 20 字）' }, 400)
        house.name = name
      }
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true, name: house.name, owner: house.owner })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/room/rename', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    const name = String(body.name ?? '').trim()
    if (!name) return sendJson(res, { ok: false, error: '房间名不能为空' }, 400)
    if (name.length > 10) return sendJson(res, { ok: false, error: '房间名太长（最多 10 字）' }, 400)
    try {
      const house = readHouse()
      const room = house.rooms.find((r) => r.id === String(body.id || ''))
      if (!room) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      if (house.rooms.some((r) => r.id !== room.id && r.name === name)) {
        return sendJson(res, { ok: false, error: `已经有「${name}」了` }, 409)
      }
      // 先按**改名前**的 house 算出必留 id，再动名字（否则「卧室」一改，名字兜底就找不到它了）
      const keepIds = keepIdsOf(house)
      const old = room.name
      room.name = name
      // 必留房间改名后，把 id 记进偏好里，保护跟着房间走（不会因为换了名字就失守）
      if (keepIds.includes(room.id) && !readPrefs().keepRoomIds.length) writePrefs({ keepRoomIds: keepIds })
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true, from: old, to: name })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/room/add', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    const name = String(body.name ?? '').trim()
    if (!name) return sendJson(res, { ok: false, error: '房间名不能为空' }, 400)
    if (name.length > 10) return sendJson(res, { ok: false, error: '房间名太长（最多 10 字）' }, 400)
    try {
      const house = readHouse()
      if (house.rooms.some((r) => r.name === name)) return sendJson(res, { ok: false, error: `已经有「${name}」了` }, 409)
      const room = {
        id: 'room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name,
        icon: String(body.icon || '🏠').slice(0, 4),
        items: [],
        desc: ''
      }
      house.rooms.push(room)
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true, room: { id: room.id, name: room.name } })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/room/remove', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const house = readHouse()
      const room = house.rooms.find((r) => r.id === String(body.id || ''))
      if (!room) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      if (keepIdsOf(house).includes(room.id)) return sendJson(res, { ok: false, error: `「${room.name}」是必须保留的房间` }, 400)
      if (house.rooms.length <= 3) return sendJson(res, { ok: false, error: '房间太少了（至少留 3 间）' }, 400)

      const locked = room.items.filter((i) => kindOf(i) && !kindOf(i).movable)
      const tvs = room.items.filter((i) => /电视/.test(i))
      const others = room.items.filter((i) => !kindOf(i))
      const mustMove = [...locked, ...tvs]

      let target = null
      if (mustMove.length) {
        target = house.rooms.find((r) => r.id === String(body.moveTo || ''))
        if (!target || target.id === room.id) {
          return sendJson(res, {
            ok: false,
            needMove: true,
            error: `「${room.name}」里有带状态栏的家具（${mustMove.join('、')}），要先选一个房间放过去`,
            items: mustMove,
            candidates: house.rooms.filter((r) => r.id !== room.id).map((r) => ({ id: r.id, name: r.name }))
          }, 409)
        }
      }

      if (target) target.items = [...target.items, ...mustMove]
      house.rooms = house.rooms.filter((r) => r.id !== room.id)
      if (house.current === room.id) house.current = (target && target.id) || house.rooms[0].id
      saveHouse(house)
      await rerender()
      sendJson(res, {
        ok: true,
        removed: room.name,
        movedTo: target ? target.name : null,
        moved: mustMove,
        dropped: others
      })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/item/rename', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    const to = String(body.to ?? '').trim()
    if (!to) return sendJson(res, { ok: false, error: '新名字不能为空' }, 400)
    if (to.length > 30) return sendJson(res, { ok: false, error: '名字太长（最多 30 字）' }, 400)
    try {
      const house = readHouse()
      const room = house.rooms.find((r) => r.id === String(body.roomId || ''))
      if (!room) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      const from = String(body.from || '')
      const idx = room.items.indexOf(from)
      if (idx < 0) return sendJson(res, { ok: false, error: '这件家具不在这个屋里' }, 404)
      if (room.items.includes(to)) return sendJson(res, { ok: false, error: `${room.name}里已经有一件「${to}」了` }, 409)

      const fromKind = kindOf(from)
      const toKind = kindOf(to)
      // 带状态栏的家具（电视/电脑/冰箱/鱼缸）**可以改名**，但新名字必须保留原来那个词，
      // 不然状态栏就认不出它了 —— 规则跟电视一样。
      if (fromKind && !to.includes(fromKind.word)) {
        return sendJson(res, { ok: false, error: `「${from}」带状态栏，改名时得保留「${fromKind.word}」两个字` }, 400)
      }
      if (!fromKind && toKind) return sendJson(res, { ok: false, error: `「${to}」听起来像带状态栏的家具（${toKind.word}），换个名字吧` }, 400)

      room.items[idx] = to
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true, from, to })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/item/add', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    const name = String(body.name ?? '').trim()
    if (!name) return sendJson(res, { ok: false, error: '家具名不能为空' }, 400)
    if (name.length > 30) return sendJson(res, { ok: false, error: '家具名太长（最多 30 字）' }, 400)
    try {
      const house = readHouse()
      const room = house.rooms.find((r) => r.id === String(body.roomId || ''))
      if (!room) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      if (room.items.includes(name)) return sendJson(res, { ok: false, error: `${room.name}里已经有一件「${name}」了` }, 409)
      room.items.push(name)
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/item/move', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const house = readHouse()
      const from = house.rooms.find((r) => r.id === String(body.roomId || ''))
      if (!from) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      const to = house.rooms.find((r) => r.id === String(body.toRoomId || '')) || house.rooms.find((r) => r.name === String(body.to || ''))
      if (!to) return sendJson(res, { ok: false, error: '目标房间不存在' }, 404)
      if (to.id === from.id) return sendJson(res, { ok: false, error: '目标房间就是当前房间' }, 400)
      const name = String(body.from || '')
      const idx = from.items.indexOf(name)
      if (idx < 0) return sendJson(res, { ok: false, error: '这件家具不在这个屋里' }, 404)
      if (to.items.includes(name)) return sendJson(res, { ok: false, error: `「${to.name}」里已经有一件「${name}」了` }, 409)
      from.items.splice(idx, 1)
      to.items.push(name)
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true, from: from.name, to: to.name })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route('exact', '/dsh-house/api/item/remove', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST' }, 405)
    const body = await readBody(req)
    if (!body) return sendJson(res, { ok: false, error: '请求体不是 JSON' }, 400)
    try {
      const house = readHouse()
      const room = house.rooms.find((r) => r.id === String(body.roomId || ''))
      if (!room) return sendJson(res, { ok: false, error: '没有这个房间' }, 404)
      const name = String(body.name || '')
      const idx = room.items.indexOf(name)
      if (idx < 0) return sendJson(res, { ok: false, error: '这件家具不在这个屋里' }, 404)
      const kind = kindOf(name)
      if (kind && !kind.movable) return sendJson(res, { ok: false, error: `「${name}」带状态栏，不能删` }, 400)
      if (kind && kind.kind === 'tv' && tvCount(house) <= 1) return sendJson(res, { ok: false, error: '至少要留一台电视' }, 400)
      room.items.splice(idx, 1)
      saveHouse(house)
      await rerender()
      sendJson(res, { ok: true })
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })
}
