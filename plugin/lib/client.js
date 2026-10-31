// DSH 插件：小屋（设置页那一栏）
//
// 浏览器半边：设置 → 左侧栏「小屋」，两个视图：
//   · 小屋   —— iframe 显示 /dsh-house/page
//   · 高级设置 —— 改名字、增删房间、增删家具（带状态栏的家具受保护）
window.__ModuleLoader__.load({
  id: 'WhaleHouse',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const B = '/dsh-house'
    const VERSION = 'WhaleHouse-V1.0.9'

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 10, height: '100%' },
      bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      tab: (on) => ({
        border: '1px solid ' + (on ? '#8a6a45' : 'rgba(128,128,128,.35)'),
        background: on ? 'rgba(232,176,106,.16)' : 'transparent',
        color: 'inherit', padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13
      }),
      btn: {
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13
      },
      small: {
        border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit',
        padding: '3px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12
      },
      input: {
        border: '1px solid rgba(128,128,128,.35)', background: 'rgba(128,128,128,.08)', color: 'inherit',
        padding: '6px 10px', borderRadius: 8, fontSize: 13, minWidth: 160
      },
      meta: { fontSize: 12, opacity: 0.65, marginLeft: 'auto' },
      frame: { flex: 1, minHeight: 640, width: '100%', border: 'none', borderRadius: 10, background: '#14110f' },
      panel: { display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto', maxHeight: '72vh', paddingRight: 4 },
      card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
      h: { fontSize: 13, fontWeight: 600, opacity: 0.9 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      dim: { fontSize: 12, opacity: 0.6 },
      ok: { fontSize: 12, color: '#3f9e63' },
      err: { fontSize: 12, color: '#c25b4e' },
      tag: { fontSize: 11, opacity: 0.55, border: '1px solid rgba(128,128,128,.3)', borderRadius: 5, padding: '1px 6px' }
    }

    // 会话栏 tab 的标题：当前小屋的名字。
    // 关键：这个 label 在**注册那一刻**就被读走，之后不会再调用，所以：
    //   1) 先用「小屋默认名」兜底（build-release 打包时会把当前 house.name 写进来）；
    //   2) 注册前再刷新一次 /status 并覆盖；
    //   3) 之后每 5 秒刷新并写 localStorage，下次打开直接是对的。
    const DEFAULT_HOUSE_NAME = "大肥鱼的小房子" // build-release 打包时会替换成当前 house.name
    let HOUSE_LABEL = (() => {
      try { return localStorage.getItem('whalehouse-label') || DEFAULT_HOUSE_NAME } catch { return DEFAULT_HOUSE_NAME }
    })()
    function houseLabel() { return HOUSE_LABEL }
    async function refreshHouseLabel() {
      try {
        const r = await fetch(B + '/status', { cache: 'no-store' })
        const j = await r.json()
        if (j && j.name && j.name !== HOUSE_LABEL) {
          HOUSE_LABEL = j.name
          try { localStorage.setItem('whalehouse-label', j.name) } catch { /* 存不了就算了 */ }
        }
      } catch { /* 拿不到就先用旧的 */ }
    }
    setInterval(refreshHouseLabel, 5000)

    const ICONS = ['🛋️', '🛏️', '🍳', '🍽️', '🛁', '🌿', '🏊', '💻', '📦', '🏠', '🪴', '🎮', '🎨', '🐟']

    const getHouse = () => fetch(B + '/api/house', { cache: 'no-store' }).then((r) => r.json())
    const post = (p, body) => fetch(B + '/api/' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then((r) => r.json())

    function MealSettings(props) {
      const { data, busy, act } = props
      const [cfg, setCfg] = React.useState(null)
      React.useEffect(() => {
        fetch(B + '/api/meal', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
          if (j && j.ok) setCfg(j.meal?.config || {})
        }).catch(() => {})
      }, [data])
      const m = (key) => (cfg && cfg[key]) || {}
      // 值可能是分钟数（420），也可能是 "07:00" 字符串；统一转成 <input type="time"> 要的 HH:mm
      const hm = (v) => {
        if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim())) {
          const [h, mi] = v.trim().split(':')
          return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
        }
        const min = Number(v)
        if (!Number.isFinite(min) || min < 0) return '00:00'
        return String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(Math.round(min % 60)).padStart(2, '0')
      }
      const set = (key, patch2) => {
        const cur = m(key)
        const from = patch2.from !== undefined ? patch2.from : cur.from
        const to = patch2.to !== undefined ? patch2.to : cur.to
        setCfg((prev) => {
          const n = { ...prev, [key]: { ...(prev[key] || {}), ...patch2, from, to } }
          return n
        })
      }
      const MealRow = (label, key) => {
        const mm = m(key)
        return React.createElement('div', { key, style: S.row },
          React.createElement('span', { style: { ...S.dim, minWidth: 40 } }, label),
          React.createElement('input', {
            type: 'checkbox', checked: mm.enabled !== false, disabled: busy,
            onChange: (e) => set(key, { enabled: e.target.checked })
          }),
          React.createElement('input', {
            type: 'time', value: hm(mm.from || 0), disabled: busy || mm.enabled === false,
            style: S.input, onChange: (e) => set(key, { from: e.target.value })
          }),
          React.createElement('span', { style: S.dim }, '—'),
          React.createElement('input', {
            type: 'time', value: hm(mm.to || 0), disabled: busy || mm.enabled === false,
            style: S.input, onChange: (e) => set(key, { to: e.target.value })
          })
        )
      }
      // "11:00" → 660（分钟数），跟 core 的存储约定一致
      const toMin = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v
        const mm = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
        return mm ? Number(mm[1]) * 60 + Number(mm[2]) : 0
      }
      const save = () => {
        const config = {
          breakfast: { enabled: m('breakfast').enabled !== false, from: toMin(m('breakfast').from), to: toMin(m('breakfast').to) },
          lunch: { enabled: m('lunch').enabled !== false, from: toMin(m('lunch').from), to: toMin(m('lunch').to) },
          dinner: { enabled: m('dinner').enabled !== false, from: toMin(m('dinner').from), to: toMin(m('dinner').to) },
          supperEnabled: (cfg && cfg.supperEnabled) !== false,
          allDisabled: (cfg && cfg.allDisabled) === true
        }
        act('meal', { config }, '就餐设置保存好了')
      }
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.h }, '就餐设置'),
        React.createElement('div', { style: S.dim }, '到饭点会先去做饭（10~15 分钟），做好去餐厅吃（20~30 分钟），吃完随机去休息。夜宵是 22 点后、睡觉前，约三成概率想吃。'),
        MealRow('早餐', 'breakfast'),
        MealRow('午餐', 'lunch'),
        MealRow('晚餐', 'dinner'),
        React.createElement('div', { style: S.row },
          React.createElement('input', {
            type: 'checkbox', checked: (cfg && cfg.supperEnabled) !== false, disabled: busy,
            onChange: (e) => setCfg((p) => ({ ...p, supperEnabled: e.target.checked }))
          }),
          React.createElement('span', { style: S.dim }, '夜宵（22 点后、睡觉前，时间不可设）')
        ),
        React.createElement('div', { style: S.row },
          React.createElement('input', {
            type: 'checkbox', checked: (cfg && cfg.allDisabled) === true, disabled: busy,
            onChange: (e) => setCfg((p) => ({ ...p, allDisabled: e.target.checked }))
          }),
          React.createElement('span', { style: S.dim }, '不吃饭（全部关掉）')
        ),
        React.createElement('div', { style: S.row },
          React.createElement('button', { style: S.small, disabled: busy, onClick: save }, '保存')
        )
      )
    }

    function Advanced(props) {      const { data, reload, busy, setBusy, tab } = props
      const [msg, setMsg] = React.useState('')
      const [bad, setBad] = React.useState('')
      const [owner, setOwner] = React.useState('')
      const [houseName, setHouseName] = React.useState('')
      const [newRoom, setNewRoom] = React.useState('')
      const [newIcon, setNewIcon] = React.useState('🏠')
      const [selRoom, setSelRoom] = React.useState('')
      const [newItem, setNewItem] = React.useState('')
      const [moveRoom, setMoveRoom] = React.useState('')
      const [pendingRoom, setPendingRoom] = React.useState(null)
      const [editRoom, setEditRoom] = React.useState({ id: '', value: '' })
      const [rulesOpen, setRulesOpen] = React.useState(null)
      const [editItem, setEditItem] = React.useState({ roomId: '', from: '', value: '' })

      React.useEffect(() => {
        if (data?.house) {
          setHouseName(data.house.name || '')
          setOwner(data.house.owner || '')
          if (!selRoom && data.house.rooms.length) setSelRoom(data.house.rooms[0].id)
        }
      }, [data])

      const act = async (p, body, okText) => {
        setBusy(true); setBad(''); setMsg('')
        try {
          const r = await post(p, body)
          if (r.ok) { setMsg(okText || '改好了'); await reload() }
          else { setBad(r.error || '没改成') }
          return r
        } catch (e) {
          setBad(String(e?.message ?? e))
          return { ok: false }
        } finally { setBusy(false) }
      }

      const rooms = data?.house?.rooms || []
      const policy = data?.policy || { mustKeep: [], rooms: [] }
      const policyRoom = (id) => (policy.rooms || []).find((r) => r.id === id)
      const room = rooms.find((r) => r.id === selRoom) || rooms[0]
      const pRoom = room ? policyRoom(room.id) : null

      const saveRoomName = async (r) => {
        const name = editRoom.value.trim()
        if (!name || name === r.name) { setEditRoom({ id: '', value: '' }); return }
        const res = await act('room/rename', { id: r.id, name }, `「${r.name}」改成了「${name}」`)
        if (res.ok) setEditRoom({ id: '', value: '' }); else setRulesOpen(res.error || '这个房间名不行')
      }

      const saveItemName = async (room, from) => {
        const to = editItem.value.trim()
        if (!to || to === from) { setEditItem({ roomId: '', from: '', value: '' }); return }
        const res = await act('item/rename', { roomId: room.id, from, to }, `「${from}」改成了「${to}」`)
        if (res.ok) setEditItem({ roomId: '', from: '', value: '' }); else setRulesOpen(res.error || '这件家具的名字不行')
      }

      const removeRoom = async (r) => {
        const pr = policyRoom(r.id)
        const locked = pr ? [...pr.lockedItems, ...pr.tvItems] : []
        if (locked.length) {
          setPendingRoom(r.id)
          setMoveRoom(rooms.filter((x) => x.id !== r.id)[0]?.id || '')
          return
        }
        if (!window.confirm(`删掉「${r.name}」？里面的家具会一起没掉。`)) return
        await act('room/remove', { id: r.id }, `删掉了「${r.name}」`)
      }

      const confirmMove = async () => {
        const r = rooms.find((x) => x.id === pendingRoom)
        if (!r || !moveRoom) return
        const targets = rooms.filter((x) => x.id !== r.id)
        const t = targets.find((x) => x.id === moveRoom)
        const res = await act('room/remove', { id: r.id, moveTo: moveRoom }, `删掉了「${r.name}」，状态栏家具搬到了「${t ? t.name : ''}」`)
        if (res.ok) setPendingRoom(null)
      }

      return React.createElement(
        'div',
        { style: S.panel },
        msg ? React.createElement('div', { style: S.ok }, msg) : null,
        bad ? React.createElement('div', { style: S.err }, bad) : null,

        tab === 'advanced' ? React.createElement(React.Fragment, null,
        // 名字
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.h }, '名字'),
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.dim }, 'bot 的名字'),
            React.createElement('input', { style: S.input, value: owner, placeholder: data?.house?.owner || '', onChange: (e) => setOwner(e.target.value) }),
            React.createElement('button', {
              style: S.small, disabled: busy,
              onClick: () => act('rename', { owner: owner.trim() }, '名字改好了')
            }, '保存')
          ),
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.dim }, '小屋的名字'),
            React.createElement('input', { style: S.input, value: houseName, onChange: (e) => setHouseName(e.target.value) }),
            React.createElement('button', {
              style: S.small, disabled: busy,
              onClick: () => act('rename', { name: houseName.trim() }, '小屋改名了')
            }, '保存')
          ),
          React.createElement('div', { style: S.dim }, 'bot 改名时，如果小屋名字还是「<旧名字>的小房子」，会跟着一起改。')
        ),

        // 自动截图发送设置（两件事放一起）
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.h }, '自动截图发送设置'),
          React.createElement('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!(data && data.prefs && data.prefs.notifyScreenshot),
              disabled: busy,
              onChange: (e) => act('prefs', { notifyScreenshot: e.target.checked }, e.target.checked ? '打开了：改完格局会发截图' : '关掉了：改完格局不发截图')
            }),
            React.createElement('span', null, 'bot 自己改了格局（添/拿/挪家具）以后，把新格局的截图发到你的私聊')
          ),
          React.createElement('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!(data && data.prefs && data.prefs.notifyOnMove),
              disabled: busy,
              onChange: (e) => act('prefs', { notifyOnMove: e.target.checked }, e.target.checked ? '打开了：她换个屋也会发截图' : '关掉了：换屋不发截图')
            }),
            React.createElement('span', null, 'bot 移动到别的房间以后，把当前小屋的截图发到你的私聊')
          ),
          React.createElement('div', { style: S.dim }, '只有 bot 动手才会触发；你在这一页做的改动不会发。截图会多花几秒，不影响她做事。')
        ),

        // 就餐设置
        React.createElement(MealSettings, { data, busy, act }),

        // 日记可见性
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('div', { style: S.h }, '笔记本日记'),
            React.createElement('span', { style: S.tag }, (data && data.prefs && data.prefs.diaryVisible === true) ? '可随时查看' : '不查看')
          ),
          React.createElement('div', { style: S.dim }, '书房那本笔记本上写着 bot 的日记。'),
          React.createElement('div', { style: S.row },
            React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 } },
              React.createElement('input', {
                type: 'radio', name: 'diaryVisible', checked: !!(data && data.prefs && data.prefs.diaryVisible === true), disabled: busy,
                onChange: () => act('prefs', { diaryVisible: true }, '日记：可随时查看')
              }),
              React.createElement('span', null, '可随时查看（房子页会多一个「看日记」入口）')
            ),
            React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 } },
              React.createElement('input', {
                type: 'radio', name: 'diaryVisible', checked: !(data && data.prefs && data.prefs.diaryVisible === true), disabled: busy,
                onChange: () => act('prefs', { diaryVisible: false }, '日记：不查看（页面上的入口和日记页都会收起来）')
              }),
              React.createElement('span', null, '不查看（日记只有 bot 自己知道）')
            )
          )
        ),

        ) : null,
        tab === 'layout' ? React.createElement(React.Fragment, null,
        // 房间
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('div', { style: S.h }, '房间（' + rooms.length + ' 间）'),
            React.createElement('button', { style: S.small, onClick: () => setRulesOpen('') }, '改名规则')
          ),
          React.createElement('div', { style: S.dim }, '必须保留：' + (policy.mustKeep || []).join('、') + '。删掉带状态栏家具的房间时，要先挑一间房把它们搬过去。'),
          rooms.map((r) => {
            const pr = policyRoom(r.id)
            const locked = pr ? [...pr.lockedItems, ...pr.tvItems] : []
            const mustKeep = pr ? pr.isMustKeep === true : false
            const editing = editRoom.id === r.id
            return React.createElement('div', { key: r.id, style: S.row },
              editing
                ? React.createElement('input', {
                  style: { ...S.input, minWidth: 120 },
                  value: editRoom.value,
                  autoFocus: true,
                  onChange: (e) => setEditRoom({ id: r.id, value: e.target.value }),
                  onKeyDown: (e) => { if (e.key === 'Enter') saveRoomName(r); if (e.key === 'Escape') setEditRoom({ id: '', value: '' }) }
                })
                : React.createElement('span', null, (r.icon || '🏠') + ' ' + r.name),
              React.createElement('span', { style: S.tag }, r.items.length + ' 件'),
              mustKeep ? React.createElement('span', { style: S.tag }, '必留') : null,
              locked.length ? React.createElement('span', { style: S.tag }, '可互动：' + locked.join('、')) : null,
              editing
                ? [
                  React.createElement('button', { key: 'ok', style: S.small, disabled: busy, onClick: () => saveRoomName(r) }, '保存'),
                  React.createElement('button', { key: 'no', style: S.small, onClick: () => setEditRoom({ id: '', value: '' }) }, '取消')
                ]
                : React.createElement('button', {
                  style: S.small, disabled: busy,
                  title: '改这间屋的名字',
                  onClick: () => setEditRoom({ id: r.id, value: r.name })
                }, '改名'),
              React.createElement('button', {
                style: S.small,
                disabled: busy || mustKeep || rooms.length <= 3,
                title: mustKeep ? '这间必须保留' : (rooms.length <= 3 ? '至少留 3 间' : '删掉这间'),
                onClick: () => removeRoom(r)
              }, mustKeep ? '必留' : '删除')
            )
          }),
          pendingRoom ? React.createElement('div', { style: { ...S.card, background: 'rgba(232,176,106,.08)' } },
            React.createElement('div', { style: S.h }, '把状态栏家具搬到哪间？'),
            React.createElement('div', { style: S.row },
              React.createElement('select', {
                style: S.input, value: moveRoom, onChange: (e) => setMoveRoom(e.target.value)
              }, rooms.filter((x) => x.id !== pendingRoom).map((x) => React.createElement('option', { key: x.id, value: x.id }, x.name))),
              React.createElement('button', { style: S.small, disabled: busy, onClick: confirmMove }, '确认删除并搬过去'),
              React.createElement('button', { style: S.small, onClick: () => setPendingRoom(null) }, '取消')
            )
          ) : null,
          React.createElement('div', { style: S.row },
            React.createElement('input', { style: { ...S.input, minWidth: 120 }, value: newRoom, placeholder: '新房间名', onChange: (e) => setNewRoom(e.target.value) }),
            React.createElement('select', { style: S.input, value: newIcon, onChange: (e) => setNewIcon(e.target.value) },
              ICONS.map((i) => React.createElement('option', { key: i, value: i }, i))),
            React.createElement('button', {
              style: S.small, disabled: busy || !newRoom.trim(),
              onClick: async () => { const r = await act('room/add', { name: newRoom.trim(), icon: newIcon }, '加了房间'); if (r.ok) setNewRoom('') }
            }, '加房间')
          )
        ),

        // 家具
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('div', { style: S.h }, '家具'),
            React.createElement('button', { style: S.small, onClick: () => setRulesOpen('') }, '改名规则')
          ),
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.dim }, '房间'),
            React.createElement('select', { style: S.input, value: selRoom, onChange: (e) => setSelRoom(e.target.value) },
              rooms.map((r) => React.createElement('option', { key: r.id, value: r.id }, r.name)))
          ),
          room ? room.items.map((item) => {
            // 一律用后端给的受保护清单判断（电视/电脑/冰箱/鱼缸/浴缸/笔记本），别再写死关键字
            const kinds = policy.protected || []
            const kind = kinds.find((k) => item.includes(k.word))
            const isLocked = !!kind && kind.movable === false
            const tvOnly = !!kind && kind.kind === 'tv' && (policy.tvCount || 0) <= 1
            const editing = editItem.roomId === room.id && editItem.from === item
            return React.createElement('div', { key: item, style: S.row },
              editing
                ? React.createElement('input', {
                  style: { ...S.input, minWidth: 180 },
                  value: editItem.value,
                  autoFocus: true,
                  onChange: (e) => setEditItem({ roomId: room.id, from: item, value: e.target.value }),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') saveItemName(room, item)
                    if (e.key === 'Escape') setEditItem({ roomId: '', from: '', value: '' })
                  }
                })
                : React.createElement('span', null, item),
              isLocked ? React.createElement('span', { style: S.tag }, '可互动') : null,
              tvOnly ? React.createElement('span', { style: S.tag }, '最后一台电视') : null,
              editing
                ? [
                  React.createElement('button', { key: 'ok', style: S.small, disabled: busy, onClick: () => saveItemName(room, item) }, '保存'),
                  React.createElement('button', { key: 'no', style: S.small, onClick: () => setEditItem({ roomId: '', from: '', value: '' }) }, '取消')
                ]
                : React.createElement('button', {
                  style: S.small,
                  disabled: busy,
                  title: isLocked ? '可以改名，但新名字要保留关键字（电脑/冰箱/鱼缸/浴缸/笔记本）' : '改这件家具的名字',
                  onClick: () => setEditItem({ roomId: room.id, from: item, value: item })
                }, '改名'),
              React.createElement('button', {
                style: S.small,
                disabled: busy || rooms.length < 2,
                title: '搬去别的房间',
                onClick: async () => {
                  const others = rooms.filter((x) => x.id !== room.id)
                  const names = others.map((x) => x.name).join(' / ')
                  const pick = window.prompt(`把「${item}」搬到哪间？\n可选：${names}`, others[0] ? others[0].name : '')
                  if (!pick) return
                  const target = others.find((x) => x.name === pick.trim()) || others.find((x) => x.id === pick.trim())
                  if (!target) { window.alert('没有这个房间'); return }
                  await act('item/move', { roomId: room.id, from: item, toRoomId: target.id }, `「${item}」搬到了「${target.name}」`)
                }
              }, '移动'),
              React.createElement('button', {
                style: S.small,
                disabled: busy || isLocked || tvOnly,
                title: isLocked ? '可互动家具不能删' : (tvOnly ? '至少要留一台电视' : '删掉'),
                onClick: async () => {
                  if (!window.confirm(`拿掉「${item}」？`)) return
                  await act('item/remove', { roomId: room.id, name: item }, `拿掉了「${item}」`)
                }
              }, '删除')
            )
          }) : null,
          React.createElement('div', { style: S.row },
            React.createElement('input', {
              style: { ...S.input, minWidth: 180 }, value: newItem, placeholder: '新家具（比如 一张摇椅）',
              onChange: (e) => setNewItem(e.target.value)
            }),
            React.createElement('button', {
              style: S.small, disabled: busy || !newItem.trim() || !room,
              onClick: async () => {
                const r = await act('item/add', { roomId: room.id, name: newItem.trim() }, '添了一件')
                if (r.ok) setNewItem('')
              }
            }, '添加到 ' + (room ? room.name : ''))
          ),
          React.createElement('div', { style: S.dim }, '可互动家具（电视/电脑/冰箱/鱼缸/浴缸/笔记本）可以改名，但新名字要保留关键字；除电视外都不能删，电视至少要留一台。'),
          React.createElement('div', { style: S.dim }, '电视里的内容要靠别的插件（比如「刷B站」）——装了它，bot 才拿得到视频、电视那行才有东西可放；本插件只负责显示。')
        ),

        ) : null,
        rulesOpen !== null ? React.createElement('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
          onClick: () => setRulesOpen(null)
        },
          React.createElement('div', {
            style: { maxWidth: 540, width: '100%', background: '#1d1916', color: '#efe6da', border: '1px solid rgba(128,128,128,.35)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '82vh', overflow: 'auto' },
            onClick: (e) => e.stopPropagation()
          },
            React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, '改名规则'),
            rulesOpen ? React.createElement('div', { style: S.err }, rulesOpen) : null,
            React.createElement('div', { style: { fontSize: 13, lineHeight: 2, opacity: 0.8 } },
              '· 房间名 1–10 字，不能和别的房间重名；至少留 3 间。卧室/厨房/卫生间也能改名，「必留」跟着房间走，改完仍然删不掉。',
              React.createElement('br'),
              '· 家具名 1–30 字，同一间屋里不能重名。',
              React.createElement('br'),
              '· 可互动家具（电视 / 电脑 / 冰箱 / 鱼缸 / 浴缸 / 笔记本）可以改名，但新名字必须保留原来的词：电视留「电视」、电脑留「电脑」、冰箱留「冰箱」、鱼缸留「鱼缸」、浴缸留「浴缸」、笔记本留「笔记本」。',
              React.createElement('br'),
              '· 普通家具不能改成「电视 / 电脑 / 冰箱 / 鱼缸 / 浴缸 / 笔记本」这类名字，不然状态栏会认错东西。'
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              React.createElement('button', { style: S.btn, onClick: () => setRulesOpen(null) }, '我知道了')
            )
          )
        ) : null
      )
    }

    function Page() {
      const [tab, setTab] = React.useState('layout')
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [st, setSt] = React.useState(null)

      const loadStatus = () => fetch(B + '/status', { cache: 'no-store' }).then((r) => r.json()).then(setSt).catch(() => {})
      const loadHouse = () => getHouse().then((d) => { if (d?.ok) setData(d) }).catch(() => {})
      const reload = async () => { await loadHouse(); await loadStatus() }

      React.useEffect(() => { loadHouse(); loadStatus() }, [])

      const tvOn = (st?.tv || []).find((t) => t.on)
      const bits = []
      if (st?.room) bits.push('现在在' + st.room)
      if (tvOn) bits.push((tvOn.room === 'living' ? '客厅' : '卧室') + '电视在放《' + tvOn.title + '》')
      if (st?.fridge) bits.push('冰箱 ' + st.fridge + ' 样')
      if (st?.tank) bits.push('鱼缸 ' + st.tank + ' 条')

      return React.createElement(
        'div',
        { style: S.wrap },
        React.createElement(
          'div',
          { style: S.bar },
          React.createElement('button', { style: S.tab(tab === 'layout'), onClick: () => setTab('layout') }, '小屋格局'),
          React.createElement('button', { style: S.tab(tab === 'advanced'), onClick: () => setTab('advanced') }, '高级设置'),
          React.createElement('span', { style: S.meta }, (st?.name || '小屋') + (bits.length ? ' · ' + bits.join(' · ') : '')),
          React.createElement('span', { style: S.tag }, VERSION)
        ),
        React.createElement(Advanced, { data, reload, busy, setBusy, tab })
      )
    }

    /**
     * 会话栏里的「小屋」。
     * · 页面里的「棋局 / 贪吃蛇」点进去，是在这个窗口里换页（iframe 自己导航），
     *   外层通过读取 iframe 的 pathname 知道现在在看哪一页；
     * · 每秒拉一次 /status，**当前这一页对应的状态变了才重载**；
     * · 子页面顶部只有「返回小屋」；它只切 iframe 地址，不碰 bot 的任何状态。
     */
    function FrameView() {
      const ref = React.useRef(null)
      const [view, setView] = React.useState('page')
      const sigRef = React.useRef('')

      const onLoad = () => {
        try {
          const pathname = ref.current && ref.current.contentWindow && ref.current.contentWindow.location.pathname
          const m = String(pathname || '').match(/^\/dsh-house\/([a-z]+)/)
          if (m) setView(m[1])
        } catch { /* 跨域/拿不到就保持原状 */ }
      }

      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const r = await fetch(B + '/status', { cache: 'no-store' })
            const j = await r.json()
            const sig = JSON.stringify(
              view === 'chess' ? pickChess(j)
                : view === 'snake' ? pickSnake(j)
                  : pickHouse(j)
            )
            if (!alive || sig === sigRef.current) return
            sigRef.current = sig
            const win = ref.current && ref.current.contentWindow
            if (win && win.location) win.location.reload()
          } catch { /* 下次再试 */ }
        }
        poll()
        const t = setInterval(poll, 1000)
        return () => { alive = false; clearInterval(t) }
      }, [view])

      const go = (target) => {
        setView(target)
        if (ref.current) ref.current.src = B + '/' + target + '?t=' + Date.now()
      }

      return React.createElement(
        'div',
        { style: S.wrap },
        // 小屋页不显示任何工具栏（标题、按钮都不要）；进了子页面才有
        view !== 'page'
          ? React.createElement(
            'div',
            { style: S.bar },
            React.createElement('button', { style: S.small, onClick: () => go('page') }, '返回小屋')
          )
          : null,
        React.createElement('iframe', {
          ref,
          src: B + '/page',
          onLoad,
          title: '小屋',
          style: { width: '100%', height: '100%', minHeight: 420, border: 'none', borderRadius: 8, background: '#14110f', display: 'block' }
        })
      )
    }

    const pickHouse = (j) => ({
      n: j.name,
      r: j.room,
      tv: (j.tv || []).map((t) => [t.on, t.title, t.last]),
      pc: [j.pc && j.pc.on === true, j.pc && j.pc.lastGame],
      f: j.fridge,
      tk: j.tank,
      c: j.chess ? [j.chess.games, j.chess.wins] : null,
      gm: j.gomoku ? j.gomoku.games : null,
      sn: (j.snake && j.snake.best ? j.snake.best : []).map((b) => b.score),
      b: j.bath ? [j.bath.on, j.bath.startedAt, j.bath.temp] : null,
      d: j.diary ? [j.diary.count, j.diary.lastAt] : null
    })
    const pickChess = (j) => (j.live && j.live.chess) || null
    const pickSnake = (j) => (j.live && j.live.snake) || null

    function HouseTab() { return React.createElement(FrameView) }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'house', order: 52, label: () => '鱼的小屋' },
          () => React.createElement(Page)
        )
      )
      // 会话头上的 tab：标题 = 当前小屋的名字
      // 先刷一次名字再注册（第一次显示就是「xx的小房子」），之后每 5 秒刷新并存 localStorage，
      // 下次打开 DSH 时一开始就是对的（DSH 只在注册时读一次 label）。
      try {
        Promise.resolve(refreshHouseLabel()).finally(() => {
          try {
            slots.inject('conversation.view', () => slots.register(
              { name: 'conversation.view', id: 'house-view', order: 30, label: () => houseLabel(), scope: 'session' },
              () => React.createElement(HouseTab)
            ))
          } catch { /* 老版本没有这个槽位就算了 */ }
        })
      } catch { /* 老版本没有这个槽位就算了 */ }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
