# dsh-visual-check

> 给 Agent 装一双眼睛的 DSH 插件。

Agent 改完前端代码，怎么知道页面**到底长什么样**？

传统做法是把 CSS/DOM 解包成文本读一遍——又贵又间接，而且读代码推不出渲染结果：布局有没有错位、按钮有没有被挤出去、颜色对不对、弹窗有没有盖住内容，这些在源码里都看不出来。

这个插件让 Agent 直接**截图**：整块屏幕、某个窗口、一块区域，或一张已有图片。图片会作为真正的图片进入模型的视野——Agent 就像人一样"看一眼"，而不是"读一遍"。

```
Agent: visual_capture{ source: "window", window: "微信", reason: "核对会话内容" }
         ↓  弹授权 → 你点允许
         ↓  自动恢复最小化 → 抓取 → 把焦点还回去 → 放回最小化
Agent: （真的看到了窗口里的内容）
```

---

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [授权机制](#授权机制)
- [行为细节](#行为细节)
- [隐私](#隐私)
- [疑难解答](#疑难解答)
- [它是怎么工作的](#它是怎么工作的)
- [开发](#开发)

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | **Windows 10 / 11**（截图走 Win32 API，其他平台不支持） |
| DSH | DeepSeek Harness（已装好并能正常使用） |
| Node.js | ≥ 20.9（DSH 自带，无需单独安装） |
| 模型 | **必须支持图片输入**，见下 |

### 关于模型

插件要求当前模型**明确声明**了图片输入能力，否则会直接报错并告诉你换模型——它不会把一张模型看不见的图塞进上下文。

已知可用的模型：

| 模型 | 说明 |
| --- | --- |
| `deepseek-flash`（DeepSeek V4.1 Flash） | 官方直连，声明了 `["text","image"]` |
| `glm-5.3-flash` | 智谱，同样声明了图片输入 |

**注意**：`deepseek-v4-pro`、`glm-5.3` 这些"更强的"型号**反而是纯文本**。遇到报错时按提示换模型即可。

> 成本参考：一张 1920×1080 的截图，DeepSeek 侧约 968 视觉 token（约 $0.0003）。同一张图如果用 DashScope 的 qwen 系列要 2027 token。相比翻 20–40K token 的 CSS 源码，视觉复核便宜一到两个数量级。

---

## 安装

> 安装会改动你的 DSH profile 配置，且**必须重启 DSH** 才能生效。

### 1. 拿到插件目录

把本仓库克隆或下载解压到任意位置，例如 `C:\tools\dsh-visual-check`。

### 2. 运行安装脚本

在这个目录下执行：

```bat
node install.mjs
```

**先跑一次不带参数的**——它是预览模式，只会告诉你将要改什么，不会动任何文件。确认无误后：

```bat
node install.mjs --apply
```

脚本会做三件事：

1. 把插件复制到 `%DSH_HOME%\local-plugins\dsh-visual-check`
2. 在 profile 的 `package.json` 里登记依赖与 bundle
3. **同时**在 profile 的 `node_modules` 里放一份（这一步不能省，见下方说明）

然后它会打印一段 `- insert:` 的 YAML 片段。

### 3. 把片段加进 profile 配置

打开 `%DSH_HOME%\profiles\<你的 profile 名>\cordis.patch.yml`
（默认 profile 名通常是 `desktop`），把脚本打印的片段**粘贴到文件末尾**。

**注意**：`insert` 只能写在这一处。写两处会触发 `duplicate loader entry id`，导致**整棵插件树加载失败**。

### 4. 重启 DSH

插件 bundle 在进程启动时组装，所以必须**完整退出后重新打开**（关窗口不够，需要从托盘退出）。

重启后，让 Agent 调用一次 `visual_windows`，能列出窗口就说明装好了。

### 卸载

1. 从 `cordis.patch.yml` 里删掉那段 `- insert:` 块
2. 从 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 中的 `dsh-visual-check`
3. 删除 `%DSH_HOME%\local-plugins\dsh-visual-check` 与 `%DSH_HOME%\profiles\<profile>\node_modules\dsh-visual-check`
4. 重启 DSH

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里那段 `insert` 条目下。**所有项都有默认值**，通常只需要改 `outputDir`。

```yaml
- insert:
    - id: dsh-visual-check
      name: 'dsh-visual-check'
      config:
        outputDir: 'C:\Users\你的用户名\.dsh\visual-checks'
        cacheDir: ''
        defaultMaxPixels: 0
        frugalMaxPixels: 1990000
        timeoutMs: 60000
        launchWaitMs: 20000
        launchers:
          - match: '微信'
            command: 'start "" "C:\Program Files\Tencent\Weixin\Weixin.exe"'
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `outputDir` | 空 | **必填**。截图落盘根目录。DSH 是长驻进程，cwd 不是会话工作区，所以必须显式指定，脚本不会替你猜。 |
| `cacheDir` | 空 | 编译缓存目录（抓屏助手的 DLL）。留空则用系统临时目录。 |
| `defaultMaxPixels` | `0` | 默认不缩图。附件服务和模型侧都会处理缩放，客户端缩图只会白白丢细节。 |
| `frugalMaxPixels` | `1990000` | `budget: "frugal"` 时用的像素上限，约 200 万。 |
| `timeoutMs` | `60000` | 单次抓屏调用的超时。 |
| `launchWaitMs` | `20000` | 启动程序后等待窗口出现的上限。 |
| `launchers` | `[]` | 预设的启动命令，窗口没打开时用。`match` 按标题或进程名子串匹配。 |

> **YAML 小坑**：单引号里反斜杠是**字面量**，不转义。所以写 `'C:\Users\x'` 是对的，
> 写成 `'C:\\Users\\x'` 反而会得到双反斜杠的非法路径。

---

## 使用

插件注册两个工具。**你不需要记这些**——Agent 会自己调用；这里是让你知道它到底在做什么。

### `visual_windows` —— 看有哪些窗口可抓

只读元数据（窗口标题与几何），**不需要授权**。

```
屏幕：2560x1440
可见窗口 11 个：
- hwnd=197724 Weixin 1300x1331 @978,48 [最小化] 「微信」
  ⚠ 已最小化：截图前会自动恢复，抓完再放回最小化
- hwnd=328256 DeepSeek Harness 1941x1243 @309,68 [前台] 「...」
- hwnd=197494 NVIDIA Overlay 2559x1440 @0,0 [覆盖层] 「NVIDIA GeForce Overlay」
  ⚠ 分层/穿透覆盖层：遮挡采样对它无意义，抓到的是它下方的屏幕内容
```

### `visual_capture` —— 抓图

四种来源：

| `source` | 用途 | 需要授权 |
| --- | --- | --- |
| `screen` | 整块屏幕 | ✅ |
| `window` | 某个窗口（按标题/进程名/hwnd，或 `handle`） | ✅ |
| `region` | 一块矩形（`regionX/Y/W/H`） | ✅ |
| `file` | 把一张已有图片交给模型看 | ❌ 不碰屏幕 |

常用参数：

| 参数 | 说明 |
| --- | --- |
| `reason` | **必填**。为什么要这张图。会展示给你作为授权依据，所以请让 Agent 写具体。 |
| `raise` | 目标被挡住时先临时置顶再抓，抓完把焦点还回去。默认 `false`。 |
| `launch` | 程序没在运行时用它启动，插件会等窗口出现。 |
| `budget` | `balanced`（默认，保留细节）或 `frugal`（压到 200 万像素以内省 token）。 |
| `title` | 这次截图的短名字，用于落盘目录命名。 |

**典型用法**：

```
# 核对开发服务器上的页面
visual_capture{ source: "url" }   ← 见下方说明，当前版本请用 window 指向浏览器
visual_capture{ source: "window", window: "localhost", reason: "核对登录页布局" }

# 目标被挡住
visual_capture{ source: "window", window: "微信", raise: true, reason: "读取当前会话" }

# 程序没开
visual_capture{ source: "window", window: "微信", launch: 'start "" "C:\...\Weixin.exe"', reason: "..." }

# 看一张已有的图
visual_capture{ source: "file", filePath: "C:\shots\design.png", reason: "对比设计稿" }
```

> **当前版本没有网页专用后端**。要核对本地开发服务器上的页面，让 Agent 抓**浏览器窗口**即可——
> 对"看一眼渲染结果"这个目的来说，浏览器窗口和网页后端看到的是一回事。
> 元素级裁剪、整页滚动截图这类网页专属能力在计划中。

---

## 授权机制

**任何屏幕 / 窗口 / 区域截图，动手前都会先弹一张授权卡给你。** 这与 Agent 是否拥有完全权限**无关**——即使给了完全权限，也必须先问。

- 你点「允许截图」→ 才继续
- 你点「不截图」→ 工具直接失败，Agent 会改用别的方式
- 授权是**对当次意图**的：换一个目标、换一个任务，会重新申请

授权卡里会显示**目标**和 Agent 写的**原因**，所以 `reason` 写得具不具体，直接决定你能不能判断该不该放行。

`file` 来源不碰屏幕，因此不弹授权。

---

## 行为细节

这三件事插件会**自动处理**，但你应该知道它做了什么。

### 最小化的窗口

自动 `SW_RESTORE` 恢复 → 抓取 → **放回最小化**。

不会把你的桌面留在被改过的状态。不需要任何参数。

### 被遮挡的窗口

**默认会明确报错，而不是默默拍一张错的图。**

这一点很关键：屏幕裁切一个被别的窗口盖住的窗口，会**静默**返回**遮挡者**的像素——不是黑图，不报错，亮度正常、颜色丰富，看起来完全像一张合法截图。这样的图交给模型，它会认真地跟你描述错的内容。

所以插件会先做 3×3 可见度采样：

```
目标窗口当前被遮挡（可见采样 0/9，即 9 个采样点里只有 0 个属于它）。
此时屏幕裁切抓到的是**遮挡者**的画面，不是目标窗口——静默返回错误内容。
两个选择：① 加 raise: true 让插件临时置顶目标并在抓完后恢复焦点；
          ② 请用户把目标窗口切到前台后再试。
```

加 `raise: true` 后，插件会临时置顶目标、抓取、**把焦点恢复原样**。

> ⚠️ 置顶会短暂抢走你的焦点。所以默认关闭，只在确实需要时才开。

### 程序没在运行

Windows **没有"打开某个窗口"这种操作**——窗口是进程创建的，进程没跑就没有窗口。所以只能**启动对应的程序**：

```
visual_capture{ source: "window", window: "微信", launch: 'start "" "C:\...\Weixin.exe"' }
```

或者在配置的 `launchers` 里预先登记（推荐，之后 Agent 就不用每次带命令了）。

> 注意：**最小化的窗口不需要 `launch`**，那类窗口会被自动恢复。`launch` 只用于程序完全没运行的情况。

---

## 隐私

**截图会拍到你屏幕上的任何东西**——包括密码、token、聊天记录、他人隐私。请认真对待下面几条。

- **每次都问**：屏幕类截图一律先弹授权，不存在"这次跳过"。
- **只拍一次**：授权针对当次，不会变成常驻许可。
- **用完即删**：截图落盘在 `outputDir`，确认无用后应删除。本插件不做任何备份或上传。
- **图片进模型上下文**：截图会作为图片发送给你当前使用的模型（与你的其他对话内容走同一条链路）。
- **会话内的副本**：DSH 会把图片规范化后存进附件缓存（`%DSH_HOME%\attachments`）。
  会话记录变长时，DSH 可能把较早的图片替换成占位文本以节省上下文——**这正是插件坚持把
  全分辨率原图落盘、并把路径写进返回文本的原因**：原图还在，随时能重新投递。

**建议**：把 `outputDir` 指到一个你自己好管理、方便清理的位置，不要指到会被同步或提交的目录。

---

## 疑难解答

### 重启后 Agent 说没有 `visual_capture` / `visual_windows` 工具

按顺序排查：

1. **profile 的 `node_modules` 里有没有这个包**——这是最常见的原因。
   profile 用 pnpm 的 `hoisted` 布局，loader 是按**包名**从
   `%DSH_HOME%\profiles\<profile>\node_modules\<包名>` 解析的。
   只往 `package.json` 写依赖**是不够的**，还要真的把包放进去（`install.mjs --apply` 会做这一步）。

   ```bat
   dir "%DSH_HOME%\profiles\desktop\node_modules\dsh-visual-check"
   ```

2. **`cordis.patch.yml` 里的 `insert` 片段加了没有**，以及有没有不小心加了两处。

3. **是不是完整重启**——关窗口不算，要从托盘退出。

4. 想看到**真正的加载错误**（GUI 和日志里都看不到），可以用 DSH 的插件管理工具把
   `include:dsh-visual-check` 关掉再打开一次，错误会直接返回。

### 报错说"当前模型没有声明图片输入"

换成支持视觉的模型（`deepseek-flash` 或 `glm-5.3-flash`）。注意 `deepseek-v4-pro` 是纯文本。

### 报错说"没有匹配「xxx」的窗口"

先用 `visual_windows` 看看实际有哪些窗口。可能是标题不完全一致，或者程序确实没运行
（那就需要 `launch`）。

### 报错说"未能取得授权"

你在授权卡上选了「不截图」，或者当前会话是**子 Agent**——子 Agent 没有向人类提问的权限，
截图必须由主会话发起。

### 抓到的是别的窗口的画面

正常情况插件会拦下来。如果确实拍到了错的内容，说明遮挡采样漏判了——
典型的漏判场景是**点击穿透的覆盖层**（如 NVIDIA Overlay）盖在目标上面，
`WindowFromPoint` 会跳过它返回下层窗口。这类窗口在 `visual_windows` 里标记为 `[覆盖层]`，
请避开它们作为抓取目标。

### 中文窗口标题乱码

已修复。如果你在用旧版本，请更新——原因是 PowerShell 5.1 的输出编码默认是 OEM 代码页
（GBK），需要显式设为 UTF-8，否则 Node 侧读到的标题是乱码，**按中文标题匹配窗口也会失败**。

### 安装脚本报"找不到 DSH_HOME"

设置环境变量 `DSH_HOME`，或用 `node install.mjs --dsh-home "D:\path\to\dsh"`。

---

## 它是怎么工作的

```
Agent
  │  visual_capture{ source: "window", window: "微信", raise: true }
  ▼
┌──────────────────────────────────────────────────────┐
│ main.mjs        能力门 → 授权门 → 目标解析 → 遮挡处理  │
│   ↓                                                  │
│ capture.mjs     起一个 PowerShell 子进程，按行协议通信 │
│   ↓                                                  │
│ grab/driver.ps1 加载缓存的 C# 助手，调用对应函数       │
│   ↓                                                  │
│ grab/VisualGrab.cs  Win32：DPI 感知 / 窗口枚举 /       │
│                    遮挡采样 / 置顶与恢复 / BitBlt 抓屏 │
│                    / 手写 PNG 编码                     │
└──────────────────────────────────────────────────────┘
  │  图片存为 DSH 附件，作为 ImageBlock 随工具结果返回
  ▼
模型直接看到图片
```

几个值得说明的设计选择：

- **纯 Win32 + 手写 PNG 编码器，零 npm 依赖**。不依赖 Playwright，不依赖任何第三方包，
  也不需要额外装浏览器——用系统自带的 Chrome/Edge 或直接抓屏即可。
- **不调用任何外部视觉 API**。理解由你当前使用的模型原生完成，插件不需要任何密钥。
- **行协议而不是 JSON**。PowerShell 5.1 的 `ConvertTo-Json` 在单元素数组、转义和编码上
  都有坑；行协议在两边都难写错。
- **抓屏助手编译一次、按源码哈希缓存**。否则每次调用都要付 1–2 秒的编译开销。

---

## 开发

```bat
npm test
```

跑两套离线测试（零网络、零花费）：

| 测试 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 纯逻辑（行协议解析、无损 JSON、命名、窗口匹配、信封文本）+ **真机抓屏**（自建一个品红测试窗口，验证枚举 / 遮挡采样 / 置顶 / 恢复焦点 / PNG 结构） |
| `test/tool.mjs` | 插件本体：工具注册、授权门、能力门、图片交付、参数校验 |

真机部分**只拍自己造的测试窗口**，不涉及你屏幕上的任何内容，可以随时重跑。

### 已知的坑（改代码前值得读一眼）

这些都是实际踩过的，且都属于"加载正常但功能失效"这一类：

1. **`parameters` 必须是扁平属性表，不是 JSON Schema。**
   DSH 的 `defineTool` 要的是 `{ 参数名: { type, description, required } }`，
   而 `output.schema` **才是** JSON Schema 对象——两者刚好相反。
   写错时报 `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`，
   因为真实现把 `type: 'object'` 当成了一个名叫 `type` 的参数。

2. **改了 `.mjs` 必须重启 DSH。** Node 按 URL 缓存 ES 模块，**开关插件条目不会重新 import**——
   它只能重跑 `apply()`。驱动脚本（`.ps1` / `.cs`）是运行时读取的，改完立即生效，不需要重启。

3. **PowerShell 脚本文件必须保持纯 ASCII。** PS 5.1 把**无 BOM 的 UTF-8** 当 ANSI 读，
   中文注释会被撕裂成引号类字符，直接破坏脚本逻辑。`grab/driver.ps1` 与
   `grab/VisualGrab.cs` 都刻意不含任何非 ASCII 字符。

4. **驱动进程要用 `windowsHide: true` 启动**，否则会闪出控制台窗口——
   而那个窗口**会被自己的截图拍到**。

5. **`PrintWindow` 不可信**：它会对 DWM 合成的窗口返回成功，但内容是纯黑。
   所以代码只信任实际像素，不信任返回值。

---

## 许可

MIT
