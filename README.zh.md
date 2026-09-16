# dsh-archived-session-delete

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 设置面板插件：
在**已归档会话**页面为每行增加永久**删除**按钮，并可扫描、删除**孤儿会话**。

DSH 本身没有删除会话的能力——归档只是把会话隐藏起来，GUI 里唯一的「删除」删的是
*工作区注册*，且会保留所有会话日志。

> **删除是永久的。** 不进回收站，无法撤销，也没有演练模式。

## 环境要求

- DSH `0.1.6-alpha.1`
- Node.js `>=20`
- `web` profile（本插件包含浏览器端）

已验证：DSH `0.1.6-alpha.1`、pnpm `12.4.1`。

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
- **是接管而非扩展原生页面。** 原生归档页组件不渲染任何子 slot，所以行内操作必须
  重新注册其 id。`list` 槽在同一 priority 下会拒绝重复 id，而原生页注册的正是同一
  个 id——因此本包以 `priority: -1` 注册，这也是平台自己推荐的遮蔽方式。
- **传输。** 在 composition 的 `webServer` 上注册单个 JSON 路由
  （`/archived-session-delete`），读取 body 之前先经 `connection.requestRejection(req)`
  信任围栏。业务失败走 200 信封，只有传输层故障使用 4xx/5xx。

## 已知限制

- **设计上就是永久的**：无撤销、无回收站、无演练。
- **孤儿检测是按需的**，不是后台扫描。
- **接管而非扩展原生页面**（见上），因此本包重新实现了该列表。若 DSH 升级改变了
  设置外壳构建导航的方式，重复行的处理逻辑可能需要重新检查。

## 开发

`tools/` 存放验证脚本，且**不随包发布**——见 [tools/README.md](tools/README.md)。

本地开发时改用 `file:` 安装；它是链接，改动无需重装即可生效。`file:` 与 `github:`
两种 spec 会互相替换，验证发布前记得切回 `github:`。

## 许可

MIT——见 [LICENSE](LICENSE)。
