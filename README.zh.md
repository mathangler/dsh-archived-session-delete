# dsh-archived-session-delete

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 设置面板插件：
在**已归档会话**页面为每行增加永久**删除**按钮，并可扫描、删除**孤儿会话**。

DSH 本身没有删除会话的能力——归档只是把会话隐藏起来，GUI 里唯一的「删除」删的是
*工作区注册*，且会保留所有会话日志。

> **删除是永久的。** 不进回收站，无法撤销，也没有演练模式。

## 环境要求

- DSH `0.1.7-alpha.1`
- Node.js `>=20`
- `web` profile（本插件包含浏览器端）
- **Windows、macOS 或 Linux** —— 不需要 PowerShell/`pwsh`，也不需要 POSIX shell
  （见[平台支持](#平台支持)）

已验证：DSH `0.1.7-alpha.1`、pnpm `12.4.1`。

## 安装

```sh
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

重启 Profile，然后打开 **设置 → 已归档会话**。

`dsh plugin` 会把参数转发给 profile 目录下的 pnpm；声明了 `dsh.bundle.patch`
的依赖会被 DSH 自动并入 `dsh.profile.bundles`，无需手动改配置。

## 更新

```sh
dsh plugin --profile web update dsh-archived-session-delete
```

`update` 会重新解析 `github:` spec 并取到最新 commit
（实测：`5465cd8` → `62c56c1` → `4e3db86`，再次执行返回 "Already up to date"）。
之后重启 Profile。

若某次 `update` 看起来没生效——比如重新打标签或强推过——可退回重装：

```sh
dsh plugin --profile web remove dsh-archived-session-delete
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-session-delete
```

重启 Profile。移除该行会一并移除它的路由与设置页，composition 的其它部分不受影响。
**已删除的会话不会因此恢复。**

## 使用

每行提供**取消归档**与**删除**。删除会**在行内**先要求确认：确认与取消按钮占据与
被替换按钮**相同的两个定宽槽位**，所以两次点击之间指针目标不会移动。结果随后显示在
**同一行内**——成功为绿色、失败为红色——成功的行约两秒后消失。
**整个过程被操作行之外的任何内容都不会移动。**

列表下方是**孤儿会话**，用分隔线区隔，并提供**扫描**按钮（扫描会遍历所有会话目录，
因此按需触发而非自动执行）。

### 一次删除会移除什么

与 `clean-dsh-sessions` skill 对齐，针对单个会话：

| 目标 | 位置 |
|---|---|
| 会话数据目录 | `<dshHome>/sessions/<project-dir>/<id>/` |
| 缓存记录 | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| 索引条目 | `global.archivedSessionIds`、`tables.workspaces[*].sessionIds` |

**孤儿会话**是磁盘上无工作区归属、也未归档的会话目录——删除项目、删除会话后留下的残留。

## 平台支持

Windows、macOS、Linux 共用同一段代码。Host 半用 `node:fs` 做文件操作、用 `node:path`
拼接路径，所以分隔符、编码与删除语义都来自运行时平台，而不是来自一段现生成的脚本。

这一点并非一直如此。`0.1.5` 及之前，Host 半组装 **PowerShell** 脚本并交给
`ctx.shell` 执行。但那不是 PowerShell 通道：`@deepseek-ai/dsh-shell` 是**抽象 bash
执行器**，宿主只会组合其中一个实现——

| 平台 | 实现 | 实际执行的东西 |
|---|---|---|
| Windows（`win32`） | `@deepseek-ai/dsh-pwsh-*` | `pwsh -NoLogo -NoProfile -NonInteractive -Command <script>` |
| macOS（`darwin`）、Linux | `@deepseek-ai/dsh-bash-*` | `bash -c <script>` |

于是在 macOS 与 Linux 上，那段 PowerShell 文本被交给了 bash，bash 回以
`bash: =: command not found` 与 `syntax error near unexpected token '('` 并以非零
退出；每一次操作都以 *“could not locate the session on disk”*（或
*“could not scan session directories”*）失败。另外两处更小的 Windows-only 假设同样
致命：硬编码的 `'\\'` 拼接在 POSIX 上产出的是 `~/.dsh\sessions`——一个合法的**文件名**，
而不是目录；`cacheRoot` 也写成了反斜杠。

`0.2.0` 彻底移除了对 shell 的依赖：不再注入 `ctx.shell`，composition 只需要
`webServer` 与 `connection`。

## 实现要点

- **索引剪除走活动注册表，而不是改文件。** 运行中的 Host 把 `workspace.json`
  握在内存里，下次变更会整文件回写，所以直接改文件会被静默还原。Host 半通过
  `workspaceRegistry.unarchiveSession` 与 `Workspace.detachSession` 完成剪除。
- **删除的几次写入有固定顺序**，而且这个顺序是必需的：
  1. 解除工作区归属 → 2. 广播 `api-session/removed` → 3. 清除归档条目 → 4. 删除磁盘数据。

  有两个不同的陷阱决定了这个顺序。分组列表的显示条件是「属于某工作区 **且** 未归档」，
  但**未分组**那一栏的条件正相反（不属于任何工作区）——所以只解除归属不会隐藏它，
  只会把它挪到未分组里去。而归档集是**到处**隐藏会话的依据，若在浏览器仍持有该会话
  摘要时就清除它，那一行就会出现。`api-session/removed` 是平台自己的「此会话已不存在」
  信号（原生 Session controller 从 `session/disposed` 发出它，浏览器端用
  `handleSessionRemoved` 响应），所以在第 3 步之前广播它，才能让该行从侧边栏消失。
  写入落盘期间出现**短暂闪烁是可接受的**；但**删除后行仍然存在**、或留下指向空处的
  归档条目，都不可以。
- **结果从客户端快照按记住的索引位置渲染**，因为删除本身会在同一次调用中把该行从
  各 store 中移除。
- **注册表里每一个全局 id 集合都会被清理，缺失的则安静降级。** DSH `0.1.7` 在
  `archivedSessionIds` 之外新增了 `pinnedSessionIds`，这给了 id 第二条「比会话活得久」
  的途径；删除时会清除持有该 id 的那一个，因此两者都不会留下指向已不存在会话的指针。
  没有 pin 集合的运行时会被读作「没有固定项」而不是抛错——这正是同一个包无需版本判断
  即可同时覆盖 `0.1.7` 及更早版本的原因。
- **本包独占 `archived-sessions` 这个 section id。** 在 DSH `0.1.7` 上已没有原生包
  提供该页面，所以这个 section 归本包独有；平台仍把该 id 映射到归档图标，这正是保留
  该 id 而非另起新 id 的原因。在 `0.1.6` 上原生归档页也曾注册它，因此本包以
  `priority: -1` 注册（平台自己推荐的遮蔽方式），并带有一小段「同一文案的重复导航行
  只保留一条」的去重逻辑。两者都保留：在 `0.1.7` 上无害，且若未来版本恢复了该 id 的
  原生页面，删除按钮仍能生效。
- **传输。** 在 composition 的 `webServer` 上注册单个 JSON 路由
  （`/archived-session-delete`），读取 body 之前先经 `connection.requestRejection(req)`
  信任围栏。业务失败走 200 信封，只有传输层故障使用 4xx/5xx。
- **文件操作全部落在 `lib/host-core.js` 的 `node:fs` 上。** 该模块不碰传输层、也不依赖
  平台，因此 HTTP 适配层得以保持轻薄可审计，删除规则也能在**无浏览器、无 shell、无 DSH
  进程**的条件下验证（见[开发](#开发)）。删除路径被限制在 DSH home 之内；符号链接目录只
  计入体积、绝不被遍历；递归删除遇到符号链接时删除的是链接本身，而非它指向的内容。

## 已知限制

- **设计上就是永久的**：无撤销、无回收站、无演练。
- **孤儿检测是按需的**，不是后台扫描。
- **会话列表残留。** 删除数据本身并不会把该会话从浏览器的内存会话列表中逐出，这正是
  删除时要广播 `api-session/removed` 的原因。页面刷新会从 Host 重新读取列表，因此在
  再次刷新之前，被删会话可能短暂地重新出现在侧边栏的「未分组」里——这是已知且已被
  报告的粗糙之处，不是数据问题。

## 开发

`tools/` 存放验证脚本，且**不随包发布**——见 [tools/README.md](tools/README.md)。
在检出目录里执行 `npm run check` 会跑 host-core 与 HTTP 路由两组检查。

本地开发时改用 `file:` 安装；它是链接，改动无需重装即可生效。`file:` 与 `github:`
两种 spec 会互相替换，验证发布前记得切回 `github:`。

## 许可

MIT——见 [LICENSE](LICENSE)。
