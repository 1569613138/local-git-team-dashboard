# 本地 Git 团队统计看板

面向本地团队复盘的 Node.js 22 应用。服务端使用零第三方运行时依赖的 ESM，仅从本机 Git 仓库读取历史并生成统计；浏览器端提供时间、仓库、分支、作者范围、成员和聚合粒度筛选。

## macOS 下载版

从 GitHub Releases 下载 `GitContributionDashboard-v1.2.0-macos-arm64.zip`，解压后把“Git贡献看板.app”拖入“应用程序”。当前安装包适用于 Apple Silicon Mac（M1/M2/M3/M4），已经内置 Node.js，不需要安装 npm 依赖。

首次打开后：

1. 点击“选择本地仓库…”添加本机已经克隆的 Git 仓库，或点击“添加远程仓库…”填写 HTTP(S) Git 地址。
2. 按需点击“添加成员…”填写姓名、工号、Git 作者名和邮箱；也可以直接编辑完整 JSON。
3. 点击“保存并启动”。首次无缓存时，页面会自动扫描仓库。

配置、缓存、托管仓库和日志分别保存在：

```text
~/Library/Application Support/Git贡献看板/
```

Release 安装包不会包含任何真实仓库地址、人员姓名或邮箱。远程私有仓库需要系统 Git 已能通过 Credential Helper 访问。由于当前安装包使用临时签名而非 Apple Developer 公证签名，首次运行如被 macOS 拦截，请在 Finder 中右键应用选择“打开”。

## 功能

- 以“个人代码贡献排行榜”为主视图，集中展示每个人的新增行、删除行、净增行、变更总量、有效提交、Merge、活跃天数和平均变更量
- 按自然日、自然月、季度、年份选择统计周期，并支持前后周期快速切换
- 可点击任意指标列按升序/降序排列，默认按新增行从高到低
- 多仓库、默认分支或全部分支统计
- 提交数、Merge 数、新增/删除行、代码 churn 及个人贡献分布
- 路径过滤，默认忽略依赖、构建产物、覆盖率、vendor、压缩文件、source map 和 lockfile
- 成员姓名/邮箱别名归一，并区分组内成员与未映射作者
- 本地缓存、手动刷新、刷新任务进度和部分仓库失败提示

## 统计口径

- **提交**：按 commit OID 去重；扫描全部分支时，同一提交只计一次。
- **默认分支**：以仓库配置的 `defaultBranch` 为首选；筛选“默认分支”时仅统计可从该分支到达的提交。
- **Merge**：父提交数大于 1 的提交；计入提交量，但不把 Merge 本身的 diff 重复计入代码行变化。
- **新增/删除行**：来自 Git numstat；二进制文件不折算文本行数。
- **净增行**：新增行减去删除行，可为负数。
- **代码 churn / 变更总量**：新增行与删除行之和；重命名由 Git 的重命名检测处理。
- **平均变更/提交**：个人变更总量除以个人有效提交数，四舍五入为整数。
- **组内成员**：仅匹配 `members` 中 `internal: true` 的作者。匹配优先使用邮箱，其次使用规范化姓名。
- **全部作者**：包含未配置作者；未映射身份使用不可逆摘要展示，不直接暴露原始邮箱。
- **时间**：按提交的 author date 过滤和聚合；日期边界固定按 `Asia/Shanghai`（中国标准时间）解释。
- **路径过滤**：命中 `pathFilter` 的文件不参与行数与文件维度统计；提交是否保留由服务端统计实现决定。

## 只读安全边界

对于仅配置 `path` 的本地仓库，应用只执行读取类 Git 操作（如 `git log`、`git for-each-ref`、`git rev-list`、`git diff-tree`、`git rev-parse`），不执行 `checkout`、`reset`、`clean`、`commit`、`fetch`、`push` 等写操作。

配置 `remoteUrl` 时，应用会在项目 `.cache/repositories/` 下维护自己的托管副本，只对该副本执行 `clone --no-checkout` 和 `fetch`，随后扫描远程跟踪分支；不会对开发者正在使用的工作仓库执行 `fetch`、`pull` 或任何修改操作。托管目录带有应用标记，程序会拒绝覆盖非托管目录。

建议仅监听回环地址，不向公网暴露服务。应用不会修改被统计仓库；缓存只写入本项目的 `.cache/`，导出结果只写入 `outputs/`。不要把含真实路径、姓名或邮箱的 `config/app.local.json` 提交到版本库。

## 配置

复制示例后按本机情况修改：

```sh
cp config/app.example.json config/app.local.json
```

配置由 `src/server/config.js` 严格校验，不接受未列出的字段。顶层只能包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `repositories` | array | 仓库列表 |
| `members` | array | 成员身份映射；可为空 |
| `pathFilter` | object | 路径排除规则 |

`repositories[]` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 仓库稳定唯一 ID |
| `name` | string | 展示名称 |
| `path` | string | 本机仓库绝对路径；配置远程源时应指向应用专用的 `.cache/repositories/...` |
| `remoteUrl` | string | 可选，Gitea/GitLab/GitHub 的 HTTP(S) Git 地址；不得在 URL 中写用户名或令牌 |
| `defaultBranch` | string | 默认分支名，例如 `main` 或 `master` |
| `branches` | string[] | 限定分支；空数组表示不额外限定 |
| `enabled` | boolean | 是否启用该仓库 |

`members[]` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 成员稳定唯一 ID |
| `displayName` | string | 看板展示名 |
| `names` | string[] | Git author name 别名 |
| `emails` | string[] | Git author email 别名 |
| `internal` | boolean | 是否属于组内成员 |

每个成员的 `names` 和 `emails` 至少有一个非空。`pathFilter` 只能包含字符串数组 `directories`、`suffixes`、`files`，分别按目录段、文件后缀和精确文件名排除。

> `scope` 不是配置字段，而是页面/API 查询条件。`members` 为空时，默认 `scope=group` 会得到空的组内统计；首次使用建议先在本地配置中加入至少一个内部成员，或在页面选择“全部作者”（`scope=all`）。

## 启动

要求 Node.js 22+ 与可执行的 Git：

```sh
node --version
npm start
```

开发模式（服务端文件变化后自动重启）：

```sh
npm run dev
```

`start` 与 `dev` 默认读取 `config/app.local.json`。打开服务启动日志给出的本地地址即可访问看板。

## 构建 macOS 安装包

需要 macOS、Xcode Command Line Tools，以及 arm64 Node.js 22+：

```sh
NODE_BINARY="$(command -v node)" npm run build:macos
```

构建结果写入 `outputs/`：

```text
Git贡献看板.app
GitContributionDashboard-v1.2.0-macos-arm64.zip
```

构建脚本会把 Node.js、服务端与前端资源打入 App Bundle，并执行临时签名。正式对外分发若要消除系统安全提示，还需要使用 Apple Developer ID 签名和 Notarization。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/meta` | 仓库、分支及更新时间等元数据 |
| `GET` | `/api/identities` | 可筛选成员及身份映射摘要 |
| `GET` | `/api/stats` | 查询统计结果 |
| `POST` | `/api/refresh` | 同步远程托管副本（如已配置）并创建重新扫描任务 |
| `GET` | `/api/jobs/:jobId` | 查询刷新任务状态 |

`GET /api/stats` 支持 `from`、`to`、`range`、可重复的 `repo`、`branch=default|all`、`scope=group|all`、可重复的 `member` 和 `granularity=day|week|month`。`POST /api/refresh` 使用对应字段的 JSON 请求体，其中仓库和成员字段分别为 `repositories`、`members` 数组。

## 测试

```sh
npm test
npm run test:unit
npm run test:integration
```

测试使用 Node.js 内置 `node:test`。集成测试会在系统临时目录创建隔离 Git fixture，不应操作配置中的真实仓库。

## 隐私说明

Git 历史可能包含姓名、邮箱、提交信息和文件路径。所有扫描与统计均应留在本机；应用不需要上传仓库内容或调用外部服务。示例配置只使用虚构身份，真实身份仅应写入已被 `.gitignore` 忽略的 `config/app.local.json`。分享截图、导出文件、缓存或日志前，请检查其中是否包含个人信息、内部仓库名和业务路径。
