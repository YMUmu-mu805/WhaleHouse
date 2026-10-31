// 就餐模块：纯函数状态机 + 惰性调度
//
// 不依赖 QQ、不依赖调度器——桥接版在「主动机会」时调 tickMeal()，
// 服务器版在每次房子工具被调用时调 tickMeal()（惰性推进）。两边共用同一套。
//
// 吃饭流程（状态存在 home-life.json 的 meal 字段）：
//   饭点前 10~15 分钟 → 去厨房做饭（cooking，持续 10~15 分钟）
//   做完 → 去餐厅吃饭（eating，持续 20~30 分钟）
//   吃完 → 随机去一个可休息房间休息（resting，交给 setLeisure）
//
// 规则：
//   · 早餐 7-9 / 午餐 11-13 / 晚餐 17-19（可改，但三段不能重合）
//   · 夜宵 22 点后、睡觉前，约 30% 概率想吃；时间不可设
//   · 两次就餐至少间隔 3 小时
//   · 可以关掉某一顿 / 全部关掉（不吃）

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner']
const REST_ROOMS = [
  { id: 'bedroom', what: '睡觉' },
  { id: 'courtyard', what: '游泳' },
  { id: 'balcony', what: '晒太阳' },
  { id: 'study', what: '读书' }
]

export const DEFAULT_MEALS = {
  breakfast: { enabled: true, from: 7, to: 9 },
  lunch: { enabled: true, from: 11, to: 13 },
  dinner: { enabled: true, from: 17, to: 19 },
  supperEnabled: true,          // 夜宵（22 点后、睡觉前，30% 概率）
  supperChance: 0.3,
  allDisabled: false             // 用户「不吃饭」总开关
}

/** 把 HH:mm 字符串转分钟数；数字直接当作「分钟数」（0~1439）返回，不再按小时换算。 */
export function toMinutes(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 数字：约定为分钟数（0~1439）。历史上有按「小时」存的，>=24 说明是分钟，<24 按小时算。
    return v >= 0 && v < 24 ? Math.round(v) * 60 : Math.round(v)
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim())
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(v)
  if (Number.isFinite(n)) return n >= 0 && n < 24 ? Math.round(n) * 60 : Math.round(n)
  return -1
}

/** 校验 + 归一化饭点配置；三个正餐时段不能重合。兼容两种输入：扁平结构或已 normalize 过的 {meals} 结构。 */
export function normalizeMealConfig(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  // 兼容：存盘时存的是 normalize 过的 {meals:{...}}，也可能存扁平结构 {breakfast:{...}}
  const src = g.meals && typeof g.meals === 'object' ? g.meals : g
  const meals = {}
  for (const key of MEAL_ORDER) {
    const m = src[key] && typeof src[key] === 'object' ? src[key] : {}
    let from = toMinutes(m.from)
    let to = toMinutes(m.to)
    if (from < 0) from = DEFAULT_MEALS[key].from * 60
    if (to < 0) to = DEFAULT_MEALS[key].to * 60
    if (from >= to) { from = DEFAULT_MEALS[key].from * 60; to = DEFAULT_MEALS[key].to * 60 }
    meals[key] = { enabled: m.enabled !== false, from, to }
  }
  // 三段不能重合：若重合，后面的那顿整体后移（保留时长），再兜底
  for (let i = 1; i < MEAL_ORDER.length; i++) {
    const prev = meals[MEAL_ORDER[i - 1]]
    const cur = meals[MEAL_ORDER[i]]
    if (cur.from < prev.to) {
      const len = cur.to - cur.from
      cur.from = prev.to
      cur.to = prev.to + len
    }
  }
  return {
    meals,
    supperEnabled: g.supperEnabled !== false,
    supperChance: Number.isFinite(Number(g.supperChance)) ? Math.max(0, Math.min(1, Number(g.supperChance))) : DEFAULT_MEALS.supperChance,
    allDisabled: g.allDisabled === true
  }
}

/** 归一化 home-life 里的 meal 字段（存进度状态）。 */
export function normalizeMealState(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  return {
    config: normalizeMealConfig(g.config),
    // 当前正在进行的这顿饭
    active: g.active && typeof g.active === 'object'
      ? {
          kind: String(g.active.kind || ''),          // breakfast/lunch/dinner/supper
          phase: String(g.active.phase || 'cooking'), // cooking / eating
          startedAt: Number(g.active.startedAt) || 0,
          cookMinutes: Math.max(0, Number(g.active.cookMinutes) || 0),  // 计划做饭时长（10~15）
          eatMinutes: Math.max(0, Number(g.active.eatMinutes) || 0),    // 计划吃饭时长（20~30）
          done: g.active.done === true
        }
      : null,
    // 上次吃完的时间（用于 3 小时间隔）
    lastMealAt: Number(g.lastMealAt) || 0,
    // 今天已经「决定过」的饭点（避免每 tick 都重新随机，导致饭点乱跳）
    decided: g.decided && typeof g.decided === 'object' ? g.decided : {},
    decidedDay: String(g.decidedDay || ''),
    // 夜宵今晚已决定吃/不吃（避免每 tick 重掷）
    supperDecided: g.supperDecided && typeof g.supperDecided === 'object' ? g.supperDecided : null
  }
}

function todayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function hourMin(now) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/** 按当前时刻猜这是哪一顿（供"手动做饭"在没有明说 kind 时用）。 */
export function guessMealKind(now = Date.now()) {
  const hm = hourMin(now)
  if (hm >= 22 * 60 || hm < 4 * 60) return 'supper'
  if (hm < 10 * 60) return 'breakfast'
  if (hm < 14 * 60) return 'lunch'
  if (hm < 20 * 60) return 'dinner'
  return 'supper'
}

const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a

// 轻量归一化：只保证 meal / leisure 结构存在，不依赖 home-life（避免循环依赖）
function ensureLife(life) {
  const l = life && typeof life === 'object' ? life : {}
  if (!l.meal || typeof l.meal !== 'object') l.meal = {}
  if (!l.meal.decided || typeof l.meal.decided !== 'object') l.meal.decided = {}
  return l
}

/**
 * 惰性推进吃饭状态机。
 * 返回 { life, acted } —— acted 表示这一步发生了什么：
 *   · 'eating' / 'rest'   —— 一顿正在进行（手动开的），到时间推进到下一阶段
 *   · 'due'               —— 到饭点了，该提醒她去吃饭（**不替她做**，等她决定）
 *   · false               —— 没事发生
 *
 * 状态机不再「自动开火」：到饭点只报 due，由上层叫醒她、由她自己决定吃不吃。
 * 手动开的（她自己想做 / 主人叫的）仍会正常登记并推进。
 */
export function tickMeal(life, now = Date.now()) {
  const l = ensureLife(life)
  const cfg = normalizeMealConfig(l.meal.config)
  const key = todayKey(now)
  const hm = hourMin(now)

  // 0) 跨天重置：新的一天，清掉昨天的「已提醒/已跳过」记录，夜宵决定也重掷
  if (l.meal.decidedDay && l.meal.decidedDay !== key) {
    l.meal.decided = {}
    l.meal.supperDecided = null
  }
  l.meal.decidedDay = key

  // 1) 正在做饭 / 吃饭：按时间推进
  if (l.meal?.active && !l.meal.active.done) {
    const act = l.meal.active
    const elapsed = now - act.startedAt
    if (act.phase === 'cooking') {
      if (elapsed >= act.cookMinutes * 60000) {
        // 做饭完成 → 去餐厅吃饭
        act.phase = 'eating'
        act.startedAt = now
        l.leisure = { what: '吃饭', room: 'dining', at: now }
        return { life: l, acted: 'eating', kind: act.kind }
      }
      return { life: l, acted: false }
    }
    if (act.phase === 'eating') {
      if (elapsed >= act.eatMinutes * 60000) {
        // 吃完 → 标记完成，随机去休息
        l.meal.active.done = true
        l.meal.lastMealAt = now
        l.meal.decided = {}
        l.meal.supperDecided = null
        const rest = REST_ROOMS[randInt(0, REST_ROOMS.length - 1)]
        l.leisure = { what: rest.what, room: rest.id, at: now }
        return { life: l, acted: 'rest', room: rest.id, what: rest.what }
      }
      return { life: l, acted: false }
    }
  }

  // 2) 总开关关了 → 什么都不做
  if (cfg.allDisabled) return { life: l, acted: false }

  // 3) 夜宵：22 点后、睡觉前
  const isAfter22 = hm >= 22 * 60
  if (isAfter22 && cfg.supperEnabled) {
    if (now - (l.meal?.lastMealAt || 0) < 3 * 3600 * 1000) return { life: l, acted: false }
    if (!l.meal?.supperDecided) {
      const eat = Math.random() < cfg.supperChance
      l.meal = l.meal || {}
      l.meal.supperDecided = { eat, decidedAt: now, day: key }
      if (!eat) return { life: l, acted: false }
    }
    if (l.meal?.supperDecided?.eat && !l.meal.decided?.supper) {
      // 到夜宵点了 → 只提醒，不自动做
      l.meal.decided = { ...(l.meal.decided || {}), supper: true }
      return { life: l, acted: 'due', kind: 'supper' }
    }
    return { life: l, acted: false }
  }

  // 4) 正餐：三个饭点
  if (hm < 6 * 60) return { life: l, acted: false } // 凌晨 0-6 不吃正餐
  for (const kind of MEAL_ORDER) {
    const m = cfg.meals[kind]
    if (!m.enabled) continue
    // 这一顿已经「提醒过 / 跳过 / 吃过」了
    if (l.meal?.decided?.[kind]) continue
    if (hm >= m.from && hm <= m.to) {
      // 3 小时间隔
      if (now - (l.meal?.lastMealAt || 0) < 3 * 3600 * 1000) {
        // 间隔不够：标记跳过这顿（但记住，避免每 tick 都判定）
        l.meal = l.meal || {}
        l.meal.decided = { ...(l.meal.decided || {}), [kind]: true }
        return { life: l, acted: false }
      }
      // 到饭点了 → 只提醒，不自动做
      l.meal = l.meal || {}
      l.meal.decided = { ...(l.meal.decided || {}), [kind]: true }
      return { life: l, acted: 'due', kind }
    }
    // 已经过了饭点末尾还没吃 → 这顿跳过
    if (hm > m.to && !l.meal?.decided?.[kind]) {
      l.meal = l.meal || {}
      l.meal.decided = { ...(l.meal.decided || {}), [kind]: true }
    }
  }
  return { life: l, acted: false }
}

/** 开新一顿：决定做饭/吃饭时长，先去做饭。source = 'timer'（状态机）| 'self'（她自己）| 'owner'（主人叫的） */
function startMeal(l, kind, now, source = 'timer') {
  const cookMinutes = randInt(10, 15)
  const eatMinutes = randInt(20, 30)
  l.meal = l.meal || {}
  l.meal.active = {
    kind,
    phase: 'cooking',
    startedAt: now,
    cookMinutes,
    eatMinutes,
    done: false,
    source
  }
  l.meal.decided = { ...(l.meal.decided || {}) }
  if (kind !== 'supper') l.meal.decided[kind] = true
  l.leisure = { what: '做饭', room: 'kitchen', at: now }
  return { life: l, acted: 'cooking', kind, cookMinutes, eatMinutes, source }
}

/**
 * 手动做饭（她自己想做 / 主人叫的）。
 * 优先级在状态机之上：登记进 meal.active 后，状态机看到 active 就不会再开一顿。
 * 同时把这一顿标记为"手动"，状态机不会去覆盖它。
 */
export function manualMeal(life, { kind = 'lunch', source = 'self' } = {}, now = Date.now()) {
  const l = ensureLife(life)
  // 已经在做饭/吃饭了 → 不重复开
  if (l.meal.active && !l.meal.active.done) {
    return { ok: true, life: l, already: true, acted: false, active: l.meal.active }
  }
  const r = startMeal(l, kind, now, source)
  return { ok: true, life: r.life, acted: 'cooking', kind, cookMinutes: r.cookMinutes, eatMinutes: r.eatMinutes, source }
}

/** 手动触发：现在就去吃某顿饭（无视饭点，但要守 3 小时间隔）。source 标明是谁叫的。 */
export function forceMeal(life, kind, now = Date.now(), source = 'self') {
  const l = ensureLife(life)
  // 已经在做饭/吃饭 → 不重复开
  if (l.meal.active && !l.meal.active.done) {
    return { ok: true, life: l, already: true, acted: false, active: l.meal.active }
  }
  if (now - (l.meal?.lastMealAt || 0) < 3 * 3600 * 1000) {
    return { ok: false, error: '刚吃过没多久（两次就餐至少间隔 3 小时）', life: l }
  }
  const r = startMeal(l, kind, now, source)
  return { ok: true, life: r.life, acted: r.acted, source }
}

/** 当前就餐状态（给工具/页面展示用）。 */
export function mealStatus(life, now = Date.now()) {
  const l = ensureLife(life)
  const cfg = l.meal?.config || {}
  const act = l.meal?.active
  let phase = null
  if (act && !act.done) {
    const elapsed = now - act.startedAt
    if (act.phase === 'cooking') {
      const left = Math.max(0, Math.ceil((act.cookMinutes * 60000 - elapsed) / 60000))
      phase = { kind: act.kind, phase: '做饭', where: '厨房', left: `${left} 分钟` }
    } else {
      const left = Math.max(0, Math.ceil((act.eatMinutes * 60000 - elapsed) / 60000))
      phase = { kind: act.kind, phase: '吃饭', where: '餐厅', left: `${left} 分钟` }
    }
  }
  return { phase, config: cfg, lastMealAt: l.meal?.lastMealAt || 0 }
}

/** 把饭点配置转成可读文本（工具/页面共用）。入参可以是 normalize 过的，也可以是原始扁平结构。 */
export function mealConfigText(raw) {
  const cfg = normalizeMealConfig(raw)
  const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  const meals = cfg.meals || {}
  const row = (label, key) => {
    const m = meals[key] || {}
    return `${label}：${m.enabled !== false ? `${hm(m.from)}–${hm(m.to)}` : '不吃'}`
  }
  return [
    row('早餐', 'breakfast'),
    row('午餐', 'lunch'),
    row('晚餐', 'dinner'),
    `夜宵：${cfg.supperEnabled !== false ? '22 点后、睡觉前，可能吃' : '不吃'}`,
    cfg.allDisabled ? '（当前：不吃饭）' : ''
  ].filter(Boolean).join('\n')
}

/** 把运行时结构（{meals:{...}}）转回扁平结构，供写盘用。盘里永远存扁平。 */
export function flattenMealConfig(cfg) {
  const n = normalizeMealConfig(cfg)
  return {
    breakfast: { enabled: n.meals.breakfast.enabled, from: n.meals.breakfast.from, to: n.meals.breakfast.to },
    lunch: { enabled: n.meals.lunch.enabled, from: n.meals.lunch.from, to: n.meals.lunch.to },
    dinner: { enabled: n.meals.dinner.enabled, from: n.meals.dinner.from, to: n.meals.dinner.to },
    supperEnabled: n.supperEnabled,
    supperChance: n.supperChance,
    allDisabled: n.allDisabled
  }
}
