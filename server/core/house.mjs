// bot 的小房子：九间屋、各自的摆设、bot 现在在哪、以前住过哪。
//
// 设计上的几个取舍：
//   1) 数据只有一份 `state/house.json`（房间、摆设、当前位置、搬家记录），
//      页面与工具都从它派生 —— 不存第二份，就不会出现"页面和聊天里说的不一样"。
//   2) 家具就是一间屋里的几个字符串。**挪位置 = 从一间屋拿走、放进另一间**；
//      想改描述（"沙发" → "沙发（挪到了窗边）"）就 remove 再 add，不做过度结构化。
//   3) 搬家 = 换一套房间布局，旧家整份收进 history（最多留 3 个），
//      新家从三种风格里轮换（海边 / 顶楼 / 现在这种普通小屋），不会一直同一套。
//   4) 页面每次改动后重写一份静态 HTML（`exports/<名字>的小房子.html`）——
//      不依赖服务端渲染，也不怕桥接没在跑；打开就是最新的一份。
//
// 纯数据 + 纯渲染，不碰网络/进程；MCP 工具只做「读 → 改 → 存 → 重画」四步。

import fs from 'node:fs'
import path from 'node:path'
import { roomSvg, itemSvg } from './house-art.mjs'
import { env } from './env.mjs'
import { VERSION } from './version.mjs'
import { loadLife, chessStats, gomokuStats, bathStatus } from './home-life.mjs'
import { loadGame, statusText } from './chess.mjs'


export const HOUSE_FILE = path.join(env().root, 'state', 'house.json')
// 页面文件名跟着 bot 的名字走（改名后就是「<新名字>的小房子.html」）
export const pageFile = () => path.join(env().workspace, 'exports', env().petFile('小房子'))
export const catalogueFile = () => path.join(env().workspace, 'exports', env().petFile('家具图鉴'))

/** 小屋的偏好（日记能不能看等）：具体从哪读由环境决定（桥接读 house-prefs，服务器包读 settings.json） */
export function loadHousePrefs() {
  try {
    return env().prefs()
  } catch {
    return { diaryVisible: false, notifyScreenshot: false }
  }
}

/** 日记页的文件名：<名字>的日记.html（跟房子页同目录）。 */
export function diaryFileName(house) {
  return env().petFile('日记')
}

/** 页面地址：桥接给带端口的地址，服务器包返回空串（页面就在本地文件里） */
export function consolePageUrl(page) {
  try {
    return env().consoleUrl(String(page || '').replace(/^\/+/, ''))
  } catch {
    return ''
  }
}

/** 冰箱管理页的地址。 */
export function fridgePageUrl() {
  return consolePageUrl('fridge')
}

const ROOM_ALIASES = new Map([
  ['living', 'living'], ['客厅', 'living'],
  ['bedroom', 'bedroom'], ['卧室', 'bedroom'], ['房间', 'bedroom'],
  ['kitchen', 'kitchen'], ['厨房', 'kitchen'],
  ['dining', 'dining'], ['餐厅', 'dining'], ['饭厅', 'dining'],
  ['bathroom', 'bathroom'], ['卫生间', 'bathroom'], ['浴室', 'bathroom'], ['厕所', 'bathroom'],
  ['balcony', 'balcony'], ['阳台', 'balcony'], ['天台', 'balcony'],
  ['courtyard', 'courtyard'], ['庭院', 'courtyard'], ['院子', 'courtyard'], ['泳池', 'courtyard'], ['游泳池', 'courtyard'],
  ['study', 'study'], ['书房', 'study'],
  ['storage', 'storage'], ['储物间', 'storage'], ['杂物间', 'storage'], ['储藏室', 'storage']
])

/**
 * 房子布局。这一版只有一套「小屋」（plain）。
 * 搬家功能暂停，以后要加别的家：在下面再加一个 key，并把 STYLE_ORDER 补上。
 */
export const HOUSE_STYLES = {
  plain: {
    label: '小屋',
    rooms: [
      { id: 'living', name: '客厅', icon: '🛋️', items: ['沙发', '鱼缸', '客厅电视', '茶几'], desc: '' },
      { id: 'bedroom', name: '卧室', icon: '🛏️', items: ['床', '小夜灯', '空调', '地毯', '卧室电视'], desc: '' },
      { id: 'kitchen', name: '厨房', icon: '🍳', items: ['冰箱', '灶台', '热水壶', '橱柜'], desc: '' },
      { id: 'dining', name: '餐厅', icon: '🍽️', items: ['小圆桌', '两把椅子', '风景画'], desc: '' },
      { id: 'bathroom', name: '卫生间', icon: '🛁', items: ['浴缸', '镜子', '洗手池'], desc: '' },
      { id: 'balcony', name: '阳台', icon: '🌿', items: ['吊床', '鸟笼', '三个花盆'], desc: '' },
      { id: 'courtyard', name: '庭院', icon: '🏊', items: ['泳池', '躺椅', '喷泉', '花坛'], desc: '' },
      { id: 'study', name: '书房', icon: '📚', items: ['书桌', '台灯', '笔记本', '书柜', '电脑'], desc: '' },
      { id: 'storage', name: '储物间', icon: '📦', items: ['纸箱', '旧家具', '备用物品'], desc: '' }
    ]
  }
}


const STYLE_ORDER = ['plain']  // 搬家功能暂停：只保留一套房子

// 2026-10-28：房间描述不再显示（主人要求删掉），种子里的 desc 直接清空——
// 这样新开的家 / 搬家也不会再带上那几句话。
for (const style of Object.values(HOUSE_STYLES)) {
  for (const room of style.rooms) room.desc = ''
}

function normalize(house) {
  const raw = house && typeof house === 'object' ? house : {}
  const list = Array.isArray(raw.rooms) ? raw.rooms.filter((r) => r && typeof r.id === 'string') : []
  // 进门的第一个房间固定是客厅（其它房间顺序不动）
  const rooms = [
    ...list.filter((r) => r.name === '客厅' || r.id === 'living'),
    ...list.filter((r) => !(r.name === '客厅' || r.id === 'living'))
  ]
  const current = rooms.some((r) => r.id === raw.current) ? raw.current : (rooms[0]?.id ?? null)
  return {
    version: 2,
    owner: String(raw.owner || env().petName()),
    name: String(raw.name || env().petTitle('小房子')),
    style: STYLE_ORDER.includes(String(raw.style)) ? String(raw.style) : 'plain',
    current,
    movedAt: Number(raw.movedAt) || 0,
    rooms: rooms.map((r) => ({
      id: String(r.id),
      name: String(r.name || r.id),
      icon: String(r.icon || '🏠'),
      items: Array.isArray(r.items) ? r.items.map(String) : [],
      desc: String(r.desc || '')
    })),
    log: Array.isArray(raw.log) ? raw.log.slice(-30) : [],
    history: Array.isArray(raw.history)
      ? raw.history.filter((h) => h && typeof h === 'object').slice(-3).map((h) => ({
          name: String(h.name || '以前的家'),
          style: STYLE_ORDER.includes(String(h.style)) ? String(h.style) : 'plain',
          leftAt: Number(h.leftAt) || 0,
          reason: String(h.reason || ''),
          rooms: Array.isArray(h.rooms) ? h.rooms.length : 0
        }))
      : []
  }
}

export function loadHouse() {
  const read = (f) => normalize(JSON.parse(fs.readFileSync(f, 'utf8')))
  try { return read(HOUSE_FILE) } catch (error) {
    try { return read(HOUSE_FILE + '.bak.json') } catch { throw error }
  }
}

export function saveHouse(house) {
  const data = normalize(house)
  fs.mkdirSync(path.dirname(HOUSE_FILE), { recursive: true })
  // 覆盖前留一份备份
  try { if (fs.existsSync(HOUSE_FILE)) fs.copyFileSync(HOUSE_FILE, HOUSE_FILE + '.bak.json') } catch { /* 备份失败不挡存档 */ }
  const tmp = HOUSE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, HOUSE_FILE)
  return data
}

function resolveRoom(h, raw) {
  const s = String(raw ?? '').trim()
  const id = ROOM_ALIASES.get(s.toLowerCase()) || s
  return h.rooms.find((r) => r.id === id) || h.rooms.find((r) => r.name === s) || null
}

/** 走 / 回家：认 id 也认名字（「客厅」「bathroom」都行）。原地不动也算成功，只是不记日志。 */
export function moveTo(house, rawRoom, now = Date.now()) {
  const h = normalize(house)
  const target = resolveRoom(h, rawRoom)
  if (!target) {
    return { ok: false, error: `没有这间屋：「${rawRoom}」。现有的：${h.rooms.map((r) => r.name).join(' / ')}` }
  }
  const from = h.current
  if (from === target.id) {
    return { ok: true, house: h, moved: false, message: `已经在${target.name}了` }
  }
  h.current = target.id
  h.movedAt = now
  h.log.push({ at: now, room: target.id, from })
  h.log = h.log.slice(-30)
  return { ok: true, house: h, moved: true, message: `从${nameOf(h, from)}走到${target.name}` }
}

function nameOf(h, id) {
  return h.rooms.find((r) => r.id === id)?.name || '屋里'
}

const normItem = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

function findItem(h, query, roomId = null) {
  const q = normItem(query)
  if (!q) return null
  const rooms = roomId ? h.rooms.filter((r) => r.id === roomId) : h.rooms
  for (const r of rooms) {
    const exact = r.items.findIndex((it) => normItem(it) === q)
    if (exact >= 0) return { room: r, index: exact, text: r.items[exact] }
  }
  for (const r of rooms) {
    const loose = r.items.findIndex((it) => normItem(it).includes(q) || q.includes(normItem(it)))
    if (loose >= 0) return { room: r, index: loose, text: r.items[loose] }
  }
  return null
}

/** 添置（或换个说法重放）一件家具：同一间屋里已经有一模一样的就不重复加。 */
export function addFurniture(house, rawRoom, rawItem, now = Date.now()) {
  const h = normalize(house)
  const room = resolveRoom(h, rawRoom)
  const text = normItem(rawItem)
  if (!room) return { ok: false, error: `没有这间屋：「${rawRoom}」。现有的：${h.rooms.map((r) => r.name).join(' / ')}` }
  if (!text) return { ok: false, error: '家具名不能空' }
  if (room.items.some((it) => normItem(it) === text)) {
    return { ok: true, house: h, changed: false, message: `${room.name}里已经有「${text}」了` }
  }
  room.items.push(text)
  h.movedAt = now
  return { ok: true, house: h, changed: true, message: `把「${text}」放进了${room.name}` }
}

/** 拿走一件家具（认全名，也认「沙发」这种半截）。 */
export function removeFurniture(house, rawItem, now = Date.now()) {
  const h = normalize(house)
  const hit = findItem(h, rawItem)
  if (!hit) return { ok: false, error: `屋里没找到「${rawItem}」` }
  hit.room.items.splice(hit.index, 1)
  h.movedAt = now
  return { ok: true, house: h, changed: true, message: `把「${hit.text}」从${hit.room.name}拿走了` }
}

/** 挪位置：从原来那间屋拿走，放进目标屋（目标屋放同样的就只删不加）。 */
export function moveFurniture(house, rawItem, rawRoom, now = Date.now()) {
  const h = normalize(house)
  const room = resolveRoom(h, rawRoom)
  if (!room) return { ok: false, error: `没有这间屋：「${rawRoom}」。现有的：${h.rooms.map((r) => r.name).join(' / ')}` }
  const hit = findItem(h, rawItem)
  if (!hit) return { ok: false, error: `屋里没找到「${rawItem}」` }
  if (hit.room.id === room.id) return { ok: true, house: h, changed: false, message: `「${hit.text}」本来就在${room.name}` }
  hit.room.items.splice(hit.index, 1)
  room.items.push(hit.text)
  h.movedAt = now
  return { ok: true, house: h, changed: true, message: `把「${hit.text}」从${hit.room.name}挪到了${room.name}` }
}

/**
 * 搬家。
 * 这一版暂时停用了（只保留一套「小屋」）。以后要恢复：
 *   1) 在 HOUSE_STYLES 里把其它几套房子加回来、STYLE_ORDER 补上对应 key；
 *   2) 把下面 return 换成原实现（git 历史里有，或参考 1.0.4 版本的 moveHouse）。
 */
export function moveHouse(house, { style = '', reason = '', name = '' } = {}, now = Date.now()) {
  return { ok: false, error: '搬家功能暂时关闭了（这版只有一套小屋）' }
}

/** 给模型看的：现在在哪、每间屋有什么、最近走过哪、以前住过哪。 */
export function houseSummary(house) {
  const h = normalize(house)
  const cur = h.rooms.find((r) => r.id === h.current) || null
  return {
    home: { name: h.name, style: h.style, styleLabel: HOUSE_STYLES[h.style]?.label || h.style, index: h.history.length + 1 },
    now: cur ? { id: cur.id, name: cur.name, items: cur.items, desc: cur.desc } : null,
    rooms: h.rooms.map((r) => ({ id: r.id, name: r.name, items: r.items, desc: r.desc })),
    recent: h.log.slice(-5).map((l) => ({ at: l.at, from: nameOf(h, l.from), to: nameOf(h, l.room) })),
    previousHomes: h.history.map((x) => ({ name: x.name, styleLabel: HOUSE_STYLES[x.style]?.label || x.style, leftAt: x.leftAt, reason: x.reason })),
    hint: '换房间用 qq_house_move(room=房间名)；添置/拿走/挪家具用 qq_house_furniture(action=add/remove/move)。'
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

export function renderPage(house, life = null, chess = null, options = {}) {
  // 控制台里打开时标题右边给一个「设置」按钮；静态导出的 HTML 点了没法调接口，就给提示
  const withSettingsButton = options?.withSettingsButton === true
  const h = normalize(house)
  const current = h.rooms.find((r) => r.id === h.current) || h.rooms[0]
  const fridgeHref = fridgePageUrl()
  const fmtAt = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const trunc = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''))
  // 电视 / 电脑 / 冰箱 的状态栏（只在对应的屋里出现）
  const deviceBar = (r) => {
    if (!life) return ''
    if (r.id === 'living' || r.id === 'bedroom') {
      // 两台电视分开记：客厅 = 中午 12–14 + 晚上 18–22；卧室 = 其余时间
      const tv = life.tv?.[r.id] || { on: false, now: null, last: null }
      const label = r.id === 'living' ? '客厅电视' : '卧室电视'
      const on = tv.on === true
      const cur = tv.now
      const last = tv.last
      // 客厅还多一个鱼缸：显示里面养着什么鱼
      const fish = r.id === 'living' ? (life.tank?.fish || []) : []
      const tankBar = r.id === 'living'
        ? `<div class="dev"><span class="dot ${fish.length ? 'on' : 'off'}"></span><b>鱼缸</b> ${fish.length ? `${fish.length} 条：${esc(fish.map((f) => f.name).join('、'))}` : '空的'}</div>`
        : ''
      if (on) {
        return `<div class="dev"><span class="dot on"></span><b>${label}</b> 开着${cur?.title ? ` · 正在放《${esc(trunc(cur.title, 26))}》` : ' · 还没选片'}<span class="when">${fmtAt(cur?.at)}</span></div>${tankBar}`
      }
      if (last) {
        return `<div class="dev"><span class="dot off"></span><b>${label}</b> 关着 · 上次《${esc(trunc(last.title, 24))}》${last.review ? ` — 她说：${esc(trunc(last.review, 60))}` : ''}<span class="when">${fmtAt(last.at)}</span></div>${tankBar}`
      }
      return `<div class="dev"><span class="dot off"></span><b>${label}</b> 关着 · 还没看过东西<span class="hint">装了「刷B站」之类的插件，电视才会有内容</span></div>${tankBar}`
    }
    if (r.id === 'kitchen') {
      const items = life.fridge?.items || []
      const names = items.slice(-8).map((x) => x.name)
      const link = fridgeHref ? ` · <a href="${esc(fridgeHref)}" target="_blank" rel="noopener">打开冰箱</a>` : ''
      return `<div class="dev"><span class="dot ${items.length ? 'on' : 'off'}"></span><b>冰箱</b> ${items.length ? `${items.length} 样：${esc(names.join('、'))}${items.length > 8 ? ' 等' : ''}` : '空的'}${link}</div>`
    }
    if (r.id === 'bathroom') {
      // 浴缸：放水时显示水量/水温；关着只显示「关闭」
      const b = life.bath || { on: false }
      if (!b.on) return '<div class="dev"><span class="dot off"></span><b>浴缸</b> 关闭</div>'
      const st = bathStatus(life)
      return `<div class="dev"><span class="dot on"></span><b>浴缸</b> <span data-bath-start="${b.startedAt}" data-bath-temp="${st.temp}">水量 ${st.pct}% · 水温 ${st.temp}°C</span></div>`
    }
    if (r.id === 'study') {
      const best = life.snake?.best || []
      const gm = gomokuStats(life.gomoku)
      const ch = chessStats(life.chess)
      // 电脑那一条：显示**bot 上一次玩的游戏的成绩**（国际象棋/五子棋 = 场数·胜场·胜率；贪吃蛇 = 最高三局）
      const lastGame = life.pc?.lastGame || null
      let stat = '还没玩过'
      if (lastGame === 'chess') stat = `国际象棋 ${ch.games} 局 · 胜 ${ch.wins} · 胜率 ${ch.winRate}%`
      else if (lastGame === 'gomoku') stat = `五子棋 ${gm.games} 局 · 胜 ${gm.wins} · 胜率 ${gm.winRate}%`
      else if (lastGame === 'snake') stat = best.length ? `贪吃蛇最高 ${best.map((b) => b.score).join(' / ')}` : '贪吃蛇还没得分'
      const on = life.pc?.on === true
      // 小游戏那一行：三个入口
      // 棋和贪吃蛇是静态页，相对链接就够；五子棋要跟服务端交互，必须走控制台的 http 地址。
      const gamesBar = `<div class="dev"><span class="dot ${best.length ? 'on' : 'off'}"></span><b>小游戏</b>`
        + ` <a href="${env().petFile('棋局')}">国际象棋</a> · <a href="${env().petFile('贪吃蛇')}">贪吃蛇</a>`
        + ` · <a href="${esc(consolePageUrl('gomoku'))}" target="_blank" rel="noopener">五子棋</a></div>`
      // 笔记本：日记篇数；主人愿意看才给链接（house-prefs 的 diaryVisible）
      const entries = life.diary?.entries || []
      const diaryVisible = loadHousePrefs().diaryVisible === true
      const latest = entries.length ? entries[entries.length - 1] : null
      const diaryText = entries.length
        ? `日记 ${entries.length} 篇${latest ? ` · 最新 ${fmt(latest.at)}` : ''}${diaryVisible ? '' : '（主人看不到）'}`
        : '日记还是空的'
      const diaryLink = entries.length && diaryVisible
        ? ` · <a href="${esc(diaryFileName(h))}">看日记</a>`
        : ''
      return `<div class="dev"><span class="dot ${on ? 'on' : 'off'}"></span><b>电脑</b> ${on ? '开着' : '关着'} · ${esc(stat)}</div>${gamesBar}`
        + `<div class="dev"><span class="dot ${entries.length ? 'on' : 'off'}"></span><b>笔记本</b> ${esc(diaryText)}${diaryLink}</div>`
    }
    return ''
  }
  const fmt = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const cards = h.rooms.map((r) => {
    const here = r.id === current?.id
    return `
    <section class="room${here ? ' here' : ''}">
      <div class="top">
        <span class="icon">${esc(r.icon)}</span>
        <div class="names"><h2>${esc(r.name)}</h2><span class="id">${esc(r.id)}</span></div>
        ${here ? '<span class="badge">现在在这里</span>' : ''}
      </div>
      <div class="plan">${roomSvg(r, { fridgeHref })}</div>
      ${deviceBar(r)}
      <ul class="items">${r.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
      ${r.desc ? `<p class="desc">${esc(r.desc)}</p>` : ''}
    </section>`
  }).join('')
  const recent = h.log.slice(-6).reverse()
  const logHtml = recent.length
    ? recent.map((l) => `<li>${fmt(l.at)} · ${esc(nameOf(h, l.from))} → ${esc(nameOf(h, l.room))}</li>`).join('')
    : '<li>还没搬过房间。</li>'
  const prev = h.history.slice().reverse()
  const prevHtml = prev.length
    ? prev.map((x) => `<li>${esc(x.name)}（${esc(HOUSE_STYLES[x.style]?.label || x.style)}）· ${fmt(x.leftAt)} 搬走${x.reason ? ' · ' + esc(x.reason) : ''}</li>`).join('')
    : '<li>还没搬过家。</li>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(h.name)}</title>
<style>
  :root { --bg:#14110f; --card:#1d1916; --card2:#221d19; --line:#332b25; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; --accent-dim:#b98a52; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 50% -10%, #221a13 0%, var(--bg) 60%); color:var(--ink); font:15px/1.65 "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif; padding:48px 24px 64px; }
  header { max-width:1080px; margin:0 auto 28px; }
  .hd-row { display:flex; align-items:center; gap:14px; }
  .wh-open-settings { margin:-4px 0 4px; border:1px solid var(--accent-dim); color:var(--accent); background:rgba(232,176,106,.08); border-radius:20px; padding:5px 14px; font-size:12.5px; letter-spacing:1px; cursor:pointer; font-family:inherit; }
  .wh-open-settings:hover { background:rgba(232,176,106,.18); }
  h1 { margin:0 0 6px; font-size:30px; letter-spacing:2px; font-weight:600; }
  .sub { color:var(--muted); font-size:13.5px; letter-spacing:.5px; }
  .sub b { color:var(--accent); font-weight:500; }
  .grid { max-width:1080px; margin:0 auto; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); }
  .room { background:linear-gradient(180deg,var(--card2),var(--card)); border:1px solid var(--line); border-radius:14px; padding:18px 18px 16px; display:flex; flex-direction:column; gap:10px; min-height:190px; }
  .room.here { border-color:var(--accent-dim); box-shadow:0 0 0 1px rgba(232,176,106,.25), 0 8px 30px rgba(232,176,106,.07); }
  .top { display:flex; align-items:center; gap:10px; }
  .icon { font-size:22px; line-height:1; }
  .names { display:flex; align-items:baseline; gap:8px; flex:1; min-width:0; }
  h2 { margin:0; font-size:17px; font-weight:600; letter-spacing:1px; }
  .id { color:#6f6357; font-size:11px; font-family:ui-monospace,Consolas,monospace; }
  .badge { font-size:11px; color:#1a140e; background:var(--accent); border-radius:999px; padding:2px 9px; white-space:nowrap; }
  .plan { border-radius:8px; overflow:hidden; background:#1a1512; }
  .dev { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; color:#c3b29c; background:#241f1a; border:1px solid #352c25; border-radius:8px; padding:5px 8px; line-height:1.5; }
  .dev b { color:#e2d3bd; font-weight:500; }
  .dev a { color:#c9a877; }
.dev .hint { color:#8d7f70; font-size:10.5px; }
  .dot { width:6px; height:6px; border-radius:50%; background:#6a5f55; flex:0 0 auto; }
  .dot.on { background:#8fd18a; box-shadow:0 0 6px rgba(143,209,138,.55); }
  .dot.off { background:#6a5f55; }
  .when { margin-left:auto; color:#6f6357; font-size:10.5px; }
  .plan svg { display:block; width:100%; height:auto; }
  .plan a { cursor:pointer; }
  .plan a:hover { filter:brightness(1.15); }
  .items { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
  .items li { font-size:12px; color:#d9c9b4; background:#2a231d; border:1px solid #3a3129; border-radius:999px; padding:2px 9px; }
  .desc { margin:0; color:var(--muted); font-size:13px; line-height:1.7; }
  .foot { max-width:1080px; margin:34px auto 0; color:#6f6357; font-size:12px; letter-spacing:.5px; display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
  .foot h3 { color:#8d7f70; font-size:12px; font-weight:500; margin:0 0 6px; letter-spacing:1px; }
  .foot ul { list-style:none; margin:0; padding:0; }
  .foot li { padding:1px 0; }
  .rule { max-width:1080px; margin:0 auto 18px; height:1px; background:linear-gradient(90deg,transparent,#3a3129,transparent); }
</style>
</head>
<body>
<header>
  <div class="hd-row">
    <h1>${esc(h.name)}</h1>
    <button type="button" class="wh-open-settings" id="wh-open-settings" data-static="${withSettingsButton ? '0' : '1'}">设置</button>
  </div>
  <div class="sub">${esc(HOUSE_STYLES[h.style]?.label || h.style)} · 九间房，一个泳池 · 现在在 <b>${esc(current?.name ?? '')}</b>（${esc(current?.icon ?? '')}）${life?.leisure ? ' · 正在' + esc(life.leisure.what) : ''}${h.movedAt ? ' · ' + fmt(h.movedAt) : ''}</div>
</header>
<div class="rule"></div>
<div class="grid">${cards}
</div>
<div class="foot">
  <div><h3>最近走动</h3><ul>${logHtml}</ul></div>
  ${h.history.length ? `<div><h3>以前住过的地方</h3><ul>${prevHtml}</ul></div>` : ''}
</div>
<div class="foot" style="margin-top:14px"><div>给${env().petTitle('小房子')} · 数据：qq-bridge/state/house.json · 每次挪家具自动重画这一页 · <a href="${env().petFile('家具图鉴')}" style="color:#c9a877">家具图鉴</a></div></div>
<script>
/* 浴缸放水是实时的：页面里嵌了开始时间，每秒按 1 分钟放满重算一次百分比 */
(() => {
  const el = document.querySelector('[data-bath-start]')
  if (!el) return
  const start = Number(el.getAttribute('data-bath-start')) || 0
  const temp = el.getAttribute('data-bath-temp') || '38'
  if (!start) return
  const tick = () => {
    const pct = Math.min(100, Math.round(((Date.now() - start) / 60000) * 100))
    el.textContent = '水量 ' + pct + '% · 水温 ' + temp + '°C'
  }
  tick()
  setInterval(tick, 1000)
})();

/* 「设置」按钮：控制台里点开面板；直接双击这个 HTML / 在 DSH 里看时，弹页面内浮层说明 */
(() => {
  const btn = document.getElementById('wh-open-settings')
  if (!btn) return

  // 用页面内浮层而不是 alert：DSH 里页面可能是沙箱 iframe，alert 会被静默吞掉
  const showTip = (inDsh) => {
    const old = document.getElementById('wh-tip-layer')
    if (old) old.remove()
    const layer = document.createElement('div')
    layer.id = 'wh-tip-layer'
    layer.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;'
    const box = document.createElement('div')
    box.style.cssText = 'max-width:520px;background:#1d1916;color:#efe6da;border:1px solid #3d332b;border-radius:14px;padding:22px 22px 16px;font:14px/1.7 "PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.55);'
    const head = document.createElement('div')
    head.style.cssText = 'color:#e8b06a;font-weight:600;margin-bottom:12px;font-size:15px;'
    head.textContent = '这个按钮不是设置入口'
    const body = document.createElement('div')
    body.style.cssText = 'color:#cdbfae;white-space:pre-wrap;'
    const nl = String.fromCharCode(10)
    const lines = inDsh
      ? ['你现在是在 DSH 里看房子页。', '', '改设置请走：左下角头像 →「设置」→ 左侧栏最下面的「鱼的小屋」。', '', '这个按钮只在「用控制台打开这个页面」时才有效（会直接展开设置面板）。']
      : ['你现在打开的是导出的静态网页。', '', '改设置请：双击包里的「打开小屋设置.bat」；或命令行 node src/ui.mjs，再打开 http://127.0.0.1:3210/。', '', '这个按钮只在「用控制台打开这个页面」时才有效（会直接展开设置面板）。']
    body.textContent = lines.join(nl)
    const foot = document.createElement('div')
    foot.style.cssText = 'margin-top:16px;text-align:right;'
    const ok = document.createElement('button')
    ok.textContent = '知道了'
    ok.style.cssText = 'border:1px solid #4a3e33;background:rgba(232,176,106,.12);color:#e8b06a;border-radius:8px;padding:7px 18px;font-size:13px;cursor:pointer;font-family:inherit;'
    ok.addEventListener('click', () => layer.remove())
    foot.appendChild(ok)
    box.appendChild(head)
    box.appendChild(body)
    box.appendChild(foot)
    layer.appendChild(box)
    layer.addEventListener('click', (e) => { if (e.target === layer) layer.remove() })
    document.body.appendChild(layer)
  }

  btn.addEventListener('click', (event) => {
    if (window.__whHasPanel) return
    event.preventDefault()
    showTip(location.pathname.indexOf('/dsh-house') === 0)
  })
})()
</script>
<div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body>
</html>`
}

export function renderCatalogue(house) {
  const h = normalize(house)
  const groups = h.rooms.map((r) => `
    <section class="group">
      <h3>${esc(r.icon)} ${esc(r.name)}<span class="cnt">${r.items.length} 件</span></h3>
      <div class="grid">${r.items.map((it) => `
        <figure class="item">
          <div class="art">${itemSvg(it)}</div>
          <figcaption>${esc(it)}</figcaption>
        </figure>`).join('')}</div>
    </section>`).join('')
  const total = h.rooms.reduce((n, r) => n + r.items.length, 0)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${env().petTitle('家具图鉴')}</title>
<style>
  :root { --bg:#14110f; --card:#1d1916; --line:#332b25; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; }
  * { box-sizing:border-box; }
  body { margin:0; padding:44px 22px 60px; background:radial-gradient(1100px 560px at 50% -10%, #221a13 0%, var(--bg) 62%); color:var(--ink); font:15px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  header { max-width:1080px; margin:0 auto 26px; }
  h1 { margin:0 0 4px; font-size:28px; letter-spacing:2px; font-weight:600; }
  .sub { color:var(--muted); font-size:13px; }
  .sub b { color:var(--accent); font-weight:500; }
  .group { max-width:1080px; margin:0 auto 26px; }
  h3 { font-size:14px; font-weight:500; color:#cbbca8; letter-spacing:1px; margin:0 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .cnt { color:#6f6357; font-size:11.5px; margin-left:8px; }
  .grid { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(118px,1fr)); }
  .item { margin:0; background:linear-gradient(180deg,#221d19,#1d1916); border:1px solid var(--line); border-radius:12px; padding:10px 8px 8px; text-align:center; }
  .art { height:64px; display:flex; align-items:center; justify-content:center; }
  .art svg { width:76px; height:auto; }
  figcaption { font-size:11.5px; color:#b9a894; line-height:1.35; margin-top:4px; word-break:break-all; }
</style>
</head>
<body>
<header>
  <h1>${env().petTitle('家具图鉴')}</h1>
  <div class="sub">${esc(h.name)} · 第 ${h.history.length + 1} 个家 · 共 <b>${total}</b> 件 · 按房间分</div>
</header>
${groups}
<div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body></html>`
}

export function writePage(house) {
  const life = (() => { try { return loadLife(); } catch { return null; } })()
  const chess = (() => { try { return loadGame(); } catch { return null; } })()
  const page = pageFile()
  fs.mkdirSync(path.dirname(page), { recursive: true })
  fs.writeFileSync(page, renderPage(house, life, chess), 'utf8')
  try {
    fs.writeFileSync(catalogueFile(), renderCatalogue(house), 'utf8')
  } catch { /* 图鉴写不出来不影响房子页 */ }
  try {
    writeDiaryPage(house, life)
  } catch { /* 日记页写不出来不影响房子页 */ }
  // 改过名字以后，旧名字的页面清掉，别在 exports 里越堆越多
  try {
    const dir = path.dirname(pageFile())
    const keep = new Set(['小房子', '家具图鉴', '棋局', '贪吃蛇', '五子棋', '日记'].map((x) => env().petFile(x)))
    for (const f of fs.readdirSync(dir)) {
      if (!/(小房子|家具图鉴|棋局|贪吃蛇|五子棋|日记)\.html$/.test(f)) continue
      if (keep.has(f)) continue
      try { fs.rmSync(path.join(dir, f), { force: true }) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 清理失败不影响页面 */ }
  return pageFile()
}

/** 笔记本里的日记：主人愿意看（house-prefs.diaryVisible）才生成这一页。 */
export function writeDiaryPage(house, life) {
  try {
    const prefs = loadHousePrefs()
    const file = path.join(env().workspace, 'exports', env().petFile('日记'))
    if (prefs.diaryVisible !== true) {
      try { fs.rmSync(file, { force: true }) } catch { /* 删不掉也无所谓 */ }
      return ''
    }
    const entries = Array.isArray(life?.diary?.entries) ? life.diary.entries : []
    const p = (n) => String(n).padStart(2, '0')
    const fmt = (ms) => {
      if (!ms) return ''
      const d = new Date(ms)
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const items = entries.length
      ? entries.slice().reverse().map((e) => `<article><time>${fmt(e.at)}</time><p>${esc(e.text)}</p></article>`).join('\n')
      : '<p class="empty">还没写过什么。</p>'
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(diaryFileName(house).replace(/\.html$/, ''))}</title>
<style>
:root { --bg:#14110f; --card:#1d1916; --line:#332b25; --ink:#efe6da; --muted:#9b8d7e; --accent:#e8b06a; }
* { box-sizing:border-box; }
body { margin:0; padding:32px 20px 60px; background:var(--bg); color:var(--ink); font:14px/1.8 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
.wrap { max-width:720px; margin:0 auto; }
h1 { font-size:22px; letter-spacing:2px; margin:0 0 4px; font-weight:600; }
.sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
article { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
time { color:var(--muted); font-size:11.5px; }
p { margin:6px 0 0; white-space:pre-wrap; }
.empty { color:var(--muted); }
a { color:#c9a877; }
</style></head>
<body><div class="wrap">
<h1>${esc(diaryFileName(house).replace(/\.html$/, ''))}</h1>
<div class="sub">书房那本笔记本 · 共 ${entries.length} 篇 · <a href="${esc(env().petFile('小房子'))}">回小房子</a></div>
${items}
</div><div style="margin-top:14px;color:#6f6357;font-size:11px;letter-spacing:1px">${VERSION}</div>
</body></html>`
    fs.writeFileSync(file, html, 'utf8')
    return file
  } catch {
    return ''
  }
}
