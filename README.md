# 哥俩好 · 无尽模式

参考抖音小游戏「哥俩好」的双人联网玩法，做成了**无尽跑酷 + 分数排名**：

> 一个人创建房间拿到房间号，另一个人输入房间号加入。两个小人被一根绳子绑在一起，
> 身后有一堵**岩浆墙**步步紧逼，不停往右跑，**跑得越远分数越高**，捡金币额外加分。
> 掉坑 / 踩尖刺 / 被岩浆追上都会掉一条命（共 3 条），命用光就结束，比谁跑得远。

- 前端：原生 HTML5 + Canvas（手机 / 电脑浏览器都能玩）
- 后端：Node.js + WebSocket（`ws`），服务端权威物理，两人画面严格同步
- 无尽关卡程序化生成，零构建，只依赖 `ws` 一个包

---

## 一、本地运行

```bash
cd geliahao
npm.cmd install      # 首次运行；Windows 上若 npm 报脚本被禁用就用 npm.cmd
npm.cmd start
```

启动后终端会打印地址（默认 3000，被占用会自动 +1）：

```
本机打开:      http://localhost:3000
同一局域网:    http://192.168.1.5:3000
```

也可以指定端口：`$env:PORT=8080; npm.cmd start`

**同一台电脑试玩**：开两个浏览器窗口打开该地址，窗口 A 创建房间，窗口 B 输入房间号加入，房主点开始。

## 二、和朋友联机

| 方式 | 说明 | 稳定性 |
| --- | --- | --- |
| 同一 WiFi | 直接用终端打印的「同一局域网」地址 | ✅ |
| 临时公网隧道 | `cloudflared` / ngrok 把本地端口映射成公网地址 | ⚠️ 电脑和进程要一直开着，网址每次重启会变 |
| 部署到云服务器 / 平台 | 见下一节 | ✅ 推荐长期使用 |

**临时公网隧道（最快，免注册）**

```bash
# 下载 cloudflared（一次即可），然后：
cloudflared tunnel --url http://localhost:3000
# 终端会给出类似 https://xxxx-xxxx.trycloudflare.com 的网址，发给朋友即可
```

> 项目自带一个下载脚本位置 `.bin/cloudflared.exe`；它支持 WebSocket 和 https（前端会自动用 `wss://`），手机上也能直接打开。

## 三、部署到公网（长期）

服务端就是标准 Node 进程，监听 `process.env.PORT`，并提供 `/healthz` 健康检查，任何支持 Node 的平台都能跑。

### 1) Render（有免费额度，推荐）
本仓库自带 `render.yaml`：
1. 把 `geliahao` 推到 GitHub；
2. Render → New → **Blueprint** → 选中仓库 → 部署；
3. 部署成功后会给你一个 `https://xxx.onrender.com` 域名。

### 2) Docker（VPS / 群晖 / 任意容器平台）
```bash
docker build -t geliahao .
docker run -d -p 3000:3000 --name geliahao geliahao
```
再配一个 Nginx/Caddy 反代并**开启 WebSocket 转发**（`Upgrade` / `Connection` 头）即可套 HTTPS。

### 3) Railway / Koyeb / Fly.io
新建项目指向仓库，构建命令 `npm install`，启动命令 `node server.js`，平台会自动注入 `PORT`。

> ⚠️ 反向代理必须支持 WebSocket，否则房间能进但一开局就掉线。
> 在线人数/房间都放在内存里，多实例部署需要做会话粘滞（或先单实例跑）。

---

## 四、操作

| 动作 | 键盘 |
| --- | --- |
| 左移 | `A` 或 `←` |
| 右移 | `D` 或 `→` |
| 跳跃（长按跳更高） | `W` / `↑` / `空格` |

手机上会自动显示屏幕按钮（左、右、跳）。

## 五、玩法细节

- **绳子**：两人距离超过 200 就会被往中间拽，必须一起跳、一起过缺口。
- **岩浆墙**：从左往右推进，速度随距离上升（110 → 275 像素/秒，玩家最快 320，跑得好不会被追上）。
- **分数** = 前进距离 ÷ 10 + 金币 × 10；死亡重生会让队伍前移一段并记录距离。
- **死亡**：掉出屏幕、踩到尖刺、被岩浆墙追上。掉命后两人在前方地面复活，岩浆墙后退一段给喘息。
- **难度**：越往后缺口越宽（90 → 约 145 像素，始终小于跳跃射程）、尖刺越多。
- 每种死亡原因都有提示；结束后可「再来一局」。

---

## 六、项目结构

```
geliahao/
├─ server.js          # 静态服务 + WebSocket 房间 + 权威物理 + 无尽关卡生成
├─ public/
│  ├─ index.html      # 首页 / 房间 / 游戏 三个界面
│  ├─ style.css
│  └─ js/app.js       # 网络、输入、渲染、插值、音效
├─ Dockerfile         # 容器部署
├─ render.yaml        # Render 蓝图
├─ package.json
└─ README.md
```

### 工作原理

- **服务端权威**：服务器以固定 60Hz 跑物理，客户端只上报按键，服务器 30Hz 广播状态、5Hz 广播关卡几何，客户端插值渲染 —— 两边画面不受设备性能/网络差异影响。
- **房间**：4 位数字房间号；先创建的是房主，后加入的是队友；房主离开自动移交；空房间保留 2 分钟方便刷新重进。
- **画面自适应**：镜头跟随两人中点，两人离得远会自动拉远。
- **音效**：WebAudio 现场合成，无需音频素材。

### 想调什么

| 想改的东西 | 位置 |
| --- | --- |
| 手感（重力/跳跃/速度） | `server.js` 顶部 `GRAVITY / JUMP_VEL / MOVE_MAX` |
| 绳子长度 | `server.js` 的 `ROPE_LEN` |
| 命数 / 金币分值 / 记分比例 | `server.js` 的 `LIVES / COIN_SCORE / METER_PX` |
| 岩浆墙速度 | `server.js` 的 `WALL_BASE_SPEED / WALL_MAX_SPEED` |
| 关卡生成规则（缺口/尖刺/金币/难度曲线） | `server.js` 的 `generate()` |
| 界面样式 | `public/style.css` |
| 角色 / 岩浆墙绘制 | `public/js/app.js` 的 `drawPlayer` / `drawWall` 等 |

改 `server.js` 后需重启服务器；改 `public/` 下文件刷新页面即可。
