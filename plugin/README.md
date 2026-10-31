# whalehouse · 小屋（DSH 插件）

把 bot 的小屋挂进 **DSH 设置**，另在会话栏开一个「小屋」看板。

## 设置里两页

- **小屋格局**（左）：房间（改名 / 删除 / 新增）、家具（改名 / 删除 / 添加）、改名规则弹窗；
- **高级设置**（右）：名字（bot / 小屋）、bot 改格局后自动截图、笔记本日记（可随时查看 / 不查看）。

## 会话栏看板

「小屋」tab：iframe 显示房子页；页面里的**国际象棋 / 贪吃蛇**点进去就在同一窗口换页，
顶部只留「返回小屋」。刷新是**轮询**：每秒拉一次 /status，当前页状态变了才重载。

## 安装

1. 把本目录放到 `C:\Users\<你>\.dsh\plugins\whalehouse`；
2. profile（`~/.dsh/profiles/desktop`）的 `package.json` 加依赖和 bundle：

```json
{
  "dependencies": { "whalehouse": "link:C:/Users/<你>/.dsh/plugins/whalehouse" },
  "dsh": { "profile": { "bundles": ["...", "whalehouse"] } }
}
```

3. 建联接：`mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\whalehouse" "%USERPROFILE%\.dsh\plugins\whalehouse"`
4. 重启 DSH → 设置左侧栏出现「小屋」。

## 配置

`cordis.patch.yml` 里的 `dir` 指向桥接目录（页面在它旁边的 `exports/`，数据在 `state/`）。

## 路由

| 路径 | 内容 |
| --- | --- |
| `GET /dsh-house/page` | 房子页 |
| `GET /dsh-house/status` | 状态 JSON（含 live.chess / live.snake 签名） |
| `GET /dsh-house/catalogue` `/chess` `/snake` `/gomoku` | 其它页面 |
| `POST /dsh-house/api/{rename,room/add,room/rename,room/remove,item/add,item/rename,item/remove,prefs}` | 设置接口 |
