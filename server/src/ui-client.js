/* WhaleHouse 控制面板（vanilla JS，挂在房子页右下角） */
(() => {
  const B = ''
  const api = (p, body) => fetch(B + '/api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then((r) => r.json())

  const css = `
  #wh-fab{position:fixed;right:18px;bottom:18px;z-index:9999;background:#e8b06a;color:#1d1916;border:none;border-radius:22px;padding:10px 16px;font:13px/1 "PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)}
  #wh-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:none}
  #wh-panel{position:fixed;right:0;top:0;bottom:0;width:min(560px,94vw);background:#1a1613;color:#efe6da;z-index:10001;display:none;flex-direction:column;box-shadow:-8px 0 30px rgba(0,0,0,.5);font:13px/1.7 "PingFang SC","Microsoft YaHei",sans-serif}
  #wh-panel header{padding:14px 16px;border-bottom:1px solid #332b25;display:flex;align-items:center;gap:8px}
  #wh-panel header b{font-size:15px}
  #wh-panel header .ver{margin-left:auto;color:#8d7f70;font-size:11px;letter-spacing:1px}
  #wh-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:14px}
  .wh-card{border:1px solid #332b25;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;background:#201b17}
  .wh-h{font-weight:600;font-size:13px;opacity:.9}
  .wh-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .wh-dim{color:#9b8d7e;font-size:12px}
  .wh-ok{color:#7fc27f;font-size:12px}
  .wh-err{color:#e08573;font-size:12px}
  input.wh-i,select.wh-i{background:#2a231e;border:1px solid #3d332b;color:#efe6da;border-radius:6px;padding:5px 8px;font-size:13px;min-width:120px}
  button.wh-b{background:transparent;border:1px solid #4a3e33;color:#efe6da;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
  button.wh-b:hover{border-color:#e8b06a;color:#e8b06a}
  button.wh-b:disabled{opacity:.4;cursor:not-allowed}
  .wh-tag{font-size:11px;color:#9b8d7e;border:1px solid #3d332b;border-radius:5px;padding:0 6px}
  `

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const fab = document.createElement('button')
  fab.id = 'wh-fab'
  fab.textContent = '设置'
  document.body.appendChild(fab)

  const mask = document.createElement('div')
  mask.id = 'wh-mask'
  document.body.appendChild(mask)

  const panel = document.createElement('div')
  panel.id = 'wh-panel'
  panel.innerHTML = `<header><button class="wh-b wh-tab" data-tab="layout">小屋格局</button><button class="wh-b wh-tab" data-tab="advanced">高级设置</button><span class="ver">WhaleHouse-V1.0.9</span><button class="wh-b" id="wh-close">关闭</button></header><div id="wh-body"></div>`
  document.body.appendChild(panel)

  const body = panel.querySelector('#wh-body')
  let state = null
  let tab = 'layout'
  let msg = ''
  let bad = ''

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  const open = async () => {
    mask.style.display = 'block'
    panel.style.display = 'flex'
    await load()
  }
  const close = () => { mask.style.display = 'none'; panel.style.display = 'none' }

  const load = async () => {
    try { state = await api('state', undefined) } catch (e) { state = null }
    render()
  }

  const act = async (p, payload, okText) => {
    msg = ''
    bad = ''
    try {
      const r = await api(p, payload)
      if (r && r.ok) { msg = okText || '改好了'; await load() } else { bad = (r && r.error) || '没改成' }
    } catch (e) { bad = String(e && e.message || e) }
    render()
  }

  const render = () => {
    if (!state || !state.ok) { body.innerHTML = '<div class="wh-err">读不到房子数据（state/house.json）</div>'; return }
    const h = state.house
    const s = state.settings
    const rooms = h.rooms || []
    const settings = (item) => {
      const words = [['电视', 'tv'], ['电脑', 'pc'], ['冰箱', 'fridge'], ['鱼缸', 'tank'], ['浴缸', 'bath'], ['笔记本', 'diary']]
      return words.find(([w]) => item.includes(w))
    }
    const parts = []
    if (tab === 'advanced') {
    parts.push(`<div class="wh-card"><div class="wh-h">名字</div>
      <div class="wh-row"><span class="wh-dim">bot 的名字</span><input class="wh-i" id="wh-owner" value="${esc(h.owner)}"><button class="wh-b" data-act="owner">保存</button></div>
      <div class="wh-row"><span class="wh-dim">小屋的名字</span><input class="wh-i" id="wh-name" value="${esc(h.name)}"><button class="wh-b" data-act="housename">保存</button></div>
      <div class="wh-dim">改 bot 名字时，如果小屋名还是「&lt;旧名字&gt;的小房子」会跟着改。</div></div>`)

    parts.push(`<div class="wh-card"><div class="wh-h">开关</div>
      <div class="wh-row"><label><input type="checkbox" id="wh-diary" ${s.diaryVisible ? 'checked' : ''}> 日记可随时查看</label></div>
      <div class="wh-row"><label><input type="checkbox" id="wh-protect" ${s.interactiveFurniture ? 'checked' : ''}> 可互动家具受保护（不能删）</label></div>
      <div class="wh-row"><button class="wh-b" data-act="settings">保存开关</button></div></div>`)

    // 自动截图发送（可选，需配 QQ 机器人通道）
    const q = state.qq || {}
    const qqReady = q.ownerQQ > 0 && q.httpUrl
    parts.push(`<div class="wh-card"><div class="wh-h">自动截图发送 <span class="wh-tag">${qqReady ? '已配好' : '未配置'}</span></div>
      <div class="wh-dim">把房子页截图发到你（ownerQQ）的私聊。需要你自己有 QQ 机器人（OneBot），配好下面两样才生效。</div>
      <div class="wh-row"><span class="wh-dim">你的 QQ 号</span><input class="wh-i" id="wh-ownerqq" value="${esc(q.ownerQQ || '')}" placeholder="比如 123456789"></div>
      <div class="wh-row"><span class="wh-dim">OneBot 地址</span><input class="wh-i" id="wh-httpurl" value="${esc(q.httpUrl || '')}" placeholder="http://127.0.0.1:3000"></div>
      <div class="wh-row"><span class="wh-dim">access token（可选）</span><input class="wh-i" id="wh-token" value="${esc(q.accessToken || '')}"></div>
      <div class="wh-row"><button class="wh-b" data-act="qqsave">保存通道</button></div>
      <div class="wh-row"><label><input type="checkbox" id="wh-notify-layout" ${q.notifyScreenshot ? 'checked' : ''}> 改格局后发截图</label></div>
      <div class="wh-row"><label><input type="checkbox" id="wh-notify-move" ${q.notifyOnMove ? 'checked' : ''}> 移动到别的房间后发截图</label></div>
      <div class="wh-row"><label><input type="checkbox" id="wh-notify-ask" ${q.askScreenshot ? 'checked' : ''}> 被问小屋状况时发截图</label></div>
      <div class="wh-row"><button class="wh-b" data-act="qqflags">保存开关</button></div></div>`)

    // 就餐设置
    const meal = state.meal || {}
    const mealCfg = meal.config || {}
    const mealSpan = (key, defFrom, defTo) => {
      const m = mealCfg[key] || {}
      const norm = (v, def) => {
        if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim())) {
          const [h, mi] = v.trim().split(':')
          return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
        }
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) return def
        return String(Math.floor(n / 60) % 24).padStart(2, '0') + ':' + String(Math.round(n % 60)).padStart(2, '0')
      }
      return {
        enabled: m.enabled !== false,
        from: norm(m.from, defFrom),
        to: norm(m.to, defTo)
      }
    }
    const mb = mealSpan('breakfast', '07:00', '09:00')
    const ml = mealSpan('lunch', '11:00', '13:00')
    const md = mealSpan('dinner', '17:00', '19:00')
    const mealRow = (id, label, v, disabled) => `<div class="wh-row">
        <label><input type="checkbox" id="wh-meal-${id}-on" ${v.enabled ? 'checked' : ''}> ${label}</label>
        <input class="wh-i" type="time" id="wh-meal-${id}-from" value="${v.from}" ${disabled ? '' : ''}>
        <span class="wh-dim">—</span>
        <input class="wh-i" type="time" id="wh-meal-${id}-to" value="${v.to}">
      </div>`
    parts.push(`<div class="wh-card"><div class="wh-h">就餐设置</div>
      <div class="wh-dim">到饭点会先去做饭（10~15 分钟），做好去餐厅吃（20~30 分钟），吃完随机去休息。夜宵是 22 点后、睡觉前，约三成概率想吃。</div>
      ${mealRow('breakfast', '早餐', mb)}
      ${mealRow('lunch', '午餐', ml)}
      ${mealRow('dinner', '晚餐', md)}
      <div class="wh-row"><label><input type="checkbox" id="wh-meal-supper" ${mealCfg.supperEnabled !== false ? 'checked' : ''}> 夜宵（22 点后、睡觉前，时间不可设）</label></div>
      <div class="wh-row"><label><input type="checkbox" id="wh-meal-off" ${mealCfg.allDisabled === true ? 'checked' : ''}> 不吃饭（全部关掉）</label></div>
      <div class="wh-row"><button class="wh-b" data-act="mealsave">保存就餐设置</button></div></div>`)
    }

    if (tab === 'layout') {
    parts.push(`<div class="wh-card"><div class="wh-h">房间（${rooms.length} 间）</div>
      <div class="wh-dim">必须保留：${(state.mustKeep || []).join('、')}；至少 3 间。</div>`)
    for (const r of rooms) {
      const must = (state.mustKeep || []).includes(r.name)
      const locked = r.items.filter((i) => settings(i))
      parts.push(`<div class="wh-row" data-room="${esc(r.id)}"><span>${esc(r.icon || '🏠')} ${esc(r.name)}</span>
        <span class="wh-tag">${r.items.length} 件</span>
        ${locked.length ? `<span class="wh-tag">可互动：${esc(locked.join('、'))}</span>` : ''}
        <button class="wh-b" data-act="room-rename" data-id="${esc(r.id)}" data-name="${esc(r.name)}">改名</button>
        <button class="wh-b" data-act="room-remove" data-id="${esc(r.id)}" data-name="${esc(r.name)}" ${must || rooms.length <= 3 ? 'disabled' : ''}>${must ? '必留' : '删除'}</button>
      </div>`)
    }
    parts.push(`<div class="wh-row"><input class="wh-i" id="wh-newroom" placeholder="新房间名"><button class="wh-b" data-act="room-add">加房间</button></div></div>`)

    const sel = h.current || (rooms[0] && rooms[0].id)
    parts.push(`<div class="wh-card"><div class="wh-h">家具</div>
      <div class="wh-row"><span class="wh-dim">房间</span><select class="wh-i" id="wh-roomsel">${rooms.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>`)
    const room = rooms.find((r) => r.id === sel)
    if (room) {
      for (const item of room.items) {
        const k = settings(item)
        const locked = k && s.interactiveFurniture && k[1] !== 'tv'
        parts.push(`<div class="wh-row"><span>${esc(item)}</span>
          ${k ? `<span class="wh-tag">可互动</span>` : ''}
          <button class="wh-b" data-act="item-rename" data-room="${esc(room.id)}" data-from="${esc(item)}">改名</button>
          <button class="wh-b" data-act="item-move" data-room="${esc(room.id)}" data-from="${esc(item)}">移动</button>
          <button class="wh-b" data-act="item-remove" data-room="${esc(room.id)}" data-from="${esc(item)}" ${locked ? 'disabled' : ''}>删除</button>
        </div>`)
      }
    }
    parts.push(`<div class="wh-row"><input class="wh-i" id="wh-newitem" placeholder="新家具（比如 一张摇椅）"><button class="wh-b" data-act="item-add" data-room="${esc(sel)}">添加</button></div></div>`)
    }

    body.innerHTML = (msg ? `<div class="wh-ok">${esc(msg)}</div>` : '') + (bad ? `<div class="wh-err">${esc(bad)}</div>` : '') + parts.join('')
    panel.querySelectorAll('.wh-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))

    // 事件
    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = btn.dataset.act
        const val = (id) => { const el = document.getElementById(id); return el ? el.value : '' }
        if (a === 'owner') await act('rename', { owner: val('wh-owner') }, '名字改好了')
        else if (a === 'housename') await act('rename', { name: val('wh-name') }, '小屋改名了')
        else if (a === 'settings') await act('settings', { diaryVisible: document.getElementById('wh-diary').checked, interactiveFurniture: document.getElementById('wh-protect').checked }, '开关改好了')
        else if (a === 'qqsave') await act('qqshot', { ownerQQ: val('wh-ownerqq'), httpUrl: val('wh-httpurl'), accessToken: val('wh-token') }, '通道保存好了')
        else if (a === 'qqflags') await act('qqshot', { notifyScreenshot: document.getElementById('wh-notify-layout').checked, notifyOnMove: document.getElementById('wh-notify-move').checked, askScreenshot: document.getElementById('wh-notify-ask').checked }, '开关保存好了')
        else if (a === 'mealsave') {
          const toMin = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v
            const mm = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
            return mm ? Number(mm[1]) * 60 + Number(mm[2]) : 0
          }
          const one = (id) => ({
            enabled: document.getElementById('wh-meal-' + id + '-on').checked,
            from: toMin(document.getElementById('wh-meal-' + id + '-from').value),
            to: toMin(document.getElementById('wh-meal-' + id + '-to').value)
          })
          await act('meal', {
            config: {
              breakfast: one('breakfast'),
              lunch: one('lunch'),
              dinner: one('dinner'),
              supperEnabled: document.getElementById('wh-meal-supper').checked,
              allDisabled: document.getElementById('wh-meal-off').checked
            }
          }, '就餐设置保存好了')
        }
        else if (a === 'room-add') await act('room/add', { name: val('wh-newroom') }, '加了房间')
        else if (a === 'room-rename') {
          const name = prompt('新的房间名', btn.dataset.name)
          if (name) await act('room/rename', { id: btn.dataset.id, name }, '房间改名了')
        } else if (a === 'room-remove') {
          if (!confirm(`删掉「${btn.dataset.name}」？`)) return
          let r = await api('room/remove', { id: btn.dataset.id })
          if (!r.ok && r.needMove) {
            const opts = (r.candidates || []).map((c) => `${c.name}`).join(' / ')
            const pick = prompt(`这屋里有可互动家具（${(r.items || []).join('、')}），搬到哪间？\n可选：${opts}`, (r.candidates && r.candidates[0] && r.candidates[0].name) || '')
            if (!pick) { bad = '已取消'; render(); return }
            const target = (r.candidates || []).find((c) => c.name === pick || c.id === pick)
            r = await api('room/remove', { id: btn.dataset.id, moveTo: target ? target.id : pick })
          }
          if (r.ok) { msg = '删掉了'; await load() } else { bad = r.error || '没删成' }
          render()
        } else if (a === 'item-add') await act('item/add', { roomId: btn.dataset.room, name: val('wh-newitem') }, '添了一件')
        else if (a === 'item-rename') {
          const to = prompt('新的名字', btn.dataset.from)
          if (to) await act('item/rename', { roomId: btn.dataset.room, from: btn.dataset.from, to }, '改名了')
        } else if (a === 'item-move') {
          const others = (state.house.rooms || []).filter((x) => x.id !== btn.dataset.room)
          const names = others.map((x) => x.name).join(' / ')
          const pick = prompt(`把「${btn.dataset.from}」搬到哪间？\n可选：${names}`, others[0] ? others[0].name : '')
          if (pick === null) return
          const target = others.find((x) => x.name === pick.trim()) || others.find((x) => x.id === pick.trim())
          if (!target) { bad = '没有这个房间'; render(); return }
          await act('item/move', { roomId: btn.dataset.room, from: btn.dataset.from, toRoomId: target.id }, `搬到了「${target.name}」`)
        } else if (a === 'item-remove') {
          if (!confirm(`拿掉「${btn.dataset.from}」？`)) return
          await act('item/remove', { roomId: btn.dataset.room, from: btn.dataset.from }, '拿掉了')
        }
      })
    })
    const selEl = document.getElementById('wh-roomsel')
    if (selEl) selEl.addEventListener('change', () => { render() })
  }

  panel.querySelectorAll('.wh-tab').forEach((b) => {
    b.addEventListener('click', () => { tab = b.dataset.tab; render() })
  })

  // 页面标题旁边的「设置」按钮（控制台模式的页面里有）
  // 告诉页面里的兜底脚本：控制台模式，按钮由这里接管
  window.__whHasPanel = true

  const bindHeaderButton = () => {
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('#wh-open-settings')
      if (!btn) return
      e.preventDefault()
      void open()
    })
  }
  bindHeaderButton()

  fab.addEventListener('click', open)
  mask.addEventListener('click', close)
  panel.querySelector('#wh-close').addEventListener('click', close)

  // 直达：?panel=1&tab=layout / tab=advanced
  const params = new URLSearchParams(location.search)
  if (params.get('tab') === 'advanced' || params.get('tab') === 'layout') tab = params.get('tab')
  if (params.get('panel') === '1') open()

  // ── 自动刷新：每 3 秒问一次 /api/page-signature，页面变了就整页重载 ──
  //   她在别处走动/开关家电时，这边不用手动 F5。
  let lastSig = ''
  let reloading = false
  const tick = async () => {
    if (reloading) return
    // 面板开着、正在输入时不打断（避免打字一半被刷掉）
    if (panel.style.display === 'flex') return
    const active = document.activeElement
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
    try {
      const r = await fetch('/api/page-signature', { cache: 'no-store' })
      const j = await r.json()
      if (!j || !j.ok) return
      if (!lastSig) { lastSig = j.sig; return }
      if (j.sig !== lastSig) {
        reloading = true
        location.reload()
      }
    } catch { /* 网络抖动就下次再试 */ }
  }
  setTimeout(() => { void tick(); setInterval(tick, 3000) }, 1200)
})()
