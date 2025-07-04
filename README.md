## Word Wiz for Kids — 启动指南

本项目是一个纯前端的儿童英语单词小应用，内置本地数据与录音/简单发音评分功能。为保证浏览器可以正确读取本地资源并使用权限接口，请务必通过本地 Web 服务器启动，而不是直接双击打开 `index.html`。

### 目录结构（节选）
- `index.html`: 入口页面
- `scripts/`: 前端脚本
- `data/words.csv`: 单词数据源（CSV）
- `assets/`: 图片资源
- `styles.css`: 样式
- `start_word_wiz.ps1`: Windows PowerShell 一键启动脚本（推荐）
- `start_word_wiz.bat`: Windows 批处理一键启动脚本（需已安装 Python）

---

### 快速启动（推荐）
#### Windows（PowerShell，一键）
方式一：文件管理器中右键 `start_word_wiz.ps1` → 选择“使用 PowerShell 运行”。

方式二：在 PowerShell 中执行（每条命令单独执行）：
1) 切换到项目根目录（包含 `index.html` 的目录）
```powershell
cd <你的项目根目录>
```
2) 启动（默认端口 8080）
```powershell
./start_word_wiz.ps1
```
3) 指定端口（可选）
```powershell
./start_word_wiz.ps1 -Port 9000
```

说明：脚本会优先使用本地 `.venv`；若未检测到系统 Python，将自动下载便携式 Python（一次性），无需安装。

提示：若遇到执行策略限制，可在当前会话临时放开后再运行脚本（两条命令分别执行）：
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
./start_word_wiz.ps1
```

#### Windows（批处理，一键）
前提：已安装 Python 3 且已加入 PATH。

1) 在命令提示符（CMD）中进入项目根目录：
```bat
cd <你的项目根目录>
```
2) 启动：
```bat
start_word_wiz.bat
```

脚本会自动在 `http://localhost:8080/` 启动并打开浏览器。

#### 手动方式（Windows/macOS/Linux）
前提：已安装 Python 3。

1) 进入项目根目录（包含 `index.html` 的目录）
```bash
cd <你的项目根目录>
```
2) 启动本地服务器（默认端口 8080）：
```bash
python -m http.server 8080
```
3) 打开浏览器访问：`http://localhost:8080/`

---

### 常见问题
- 端口被占用：
  - PowerShell 脚本：改用 `-Port` 参数（例如 `-Port 9000`）。
  - 手动启动：将命令中的 `8080` 改为其他未占用端口。
- 浏览器兼容：
  - 录音与简单发音评分依赖浏览器的麦克风与语音识别能力。推荐使用最新的 Chrome 或 Edge。
  - 某些浏览器（如 Firefox、部分 Safari 版本）可能不支持语音识别 API，届时“评分”功能会降级，但录音与回放仍可用。
- 麦克风权限：首次使用请允许站点访问麦克风；如被阻止，请在浏览器地址栏右侧的权限设置中手动放开。
- 不要直接用文件协议打开：请通过本地服务器访问，避免 `fetch` 加载 `data/words.csv` 失败或权限接口受限。

---

### 数据与自定义
- 单词数据文件：`data/words.csv`
  - 列头：`id,en,cn,pinyin,img,sent,sent_cn`
  - `img` 为空时会自动使用占位图片。
  - 修改 CSV 后，刷新页面即可生效（默认禁用缓存）。
- 首页“每日个数”可在页面右上角调整；“换一批”会在词表中向后移动一个批次。
- 如需更改默认端口：
  - PowerShell：运行时传入 `-Port` 参数。
  - 批处理：编辑 `start_word_wiz.bat` 中的 `PORT` 变量。

---

### 目录打开位置说明（重要）
无论使用脚本还是手动方式，请确保启动的工作目录就是包含 `index.html` 的目录。脚本会自动处理常见的嵌套目录情况。

---

### 开发提示
- 代码均为前端静态资源，无需安装依赖。
- 如需在其他本地服务器（Nginx、Node 等）部署，只要将项目根目录作为静态目录暴露即可。


