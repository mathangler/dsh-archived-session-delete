# dsh-archived-session-delete

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 设置面板插件：
在**已归档会话**页面为每行增加永久**删除**按钮，并可扫描、删除**孤儿会话**。

DSH 本身没有删除会话的能力——归档只是把会话隐藏起来，GUI 里唯一的「删除」删的是
*工作区注册*，且会保留所有会话日志。

**删除是永久的，不进回收站。**

## 安装

```sh
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

重启 Profile，然后打开 设置 → **已归档会话**。

更新：

```sh
dsh plugin --profile web update dsh-archived-session-delete
```

适配 DSH `0.1.5-rc.1`。

## 一次删除会移除什么

与 `clean-dsh-sessions` skill 对齐，针对单个会话：

| 目标 | 位置 |
|---|---|
| 会话数据目录 | `<dshHome>/sessions/<project-dir>/<id>/` |
| 缓存记录 | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| 索引条目 | `global.archivedSessionIds`、`tables.workspaces[*].sessionIds` |

**孤儿会话**是磁盘上无工作区归属、也未归档的会话目录。扫描会遍历所有会话目录，
因此由 **扫描** 按钮按需触发，而非自动执行。

## 交互行为

每行提供**取消归档**与**删除**。删除会**在行内**先要求确认；确认与取消按钮占据与
被替换按钮**相同的两个定宽槽位**，所以两次点击之间指针目标不会移动。结果随后显示在
**同一行内**——成功为绿色、失败为红色——成功的行约两秒后消失。
整个过程**被操作行之外的任何内容都不会移动**。

## 实现要点

- **索引剪除走活动注册表，而不是改文件。** 运行中的 Host 把 `workspace.json`
  握在内存里，下次变更会整文件回写，所以直接改文件会被静默还原。Host 半通过
  `workspaceRegistry.unarchiveSession` 与 `Workspace.detachSession` 完成剪除。
- **先解除归属，再取消归档。** 分组列表显示条件是「属于某工作区 **且** 未归档」，
  若先取消归档，会话会短暂变为可见。两者都是幂等且写在独立记录上，最终状态一致，
  顺序只是为了让那个中间帧无法被渲染出来。
- **结果从客户端快照按记住的索引位置渲染**，因为删除本身会在同一次调用中把该行从
  各 store 中移除。
- **是接管而非扩展原生页面。** 原生归档页组件不渲染任何子 slot，所以行内操作必须
  重新注册其 id。`list` 槽在同一 priority 下会拒绝重复 id，而原生页注册的正是同一
  个 id——因此本包以 `priority: -1` 注册，这也是平台自己推荐的遮蔽方式。
- **传输。** 在 composition 的 `webServer` 上注册单个 JSON 路由
  （`/archived-session-delete`），读取 body 之前先经 `connection.requestRejection(req)`
  信任围栏。业务失败走 200 信封，只有传输层故障使用 4xx/5xx。

## 开发

`tools/` 存放验证脚本，且**不随包发布**。见 [tools/README.md](tools/README.md)。

本地开发时改用 `file:` 安装——它是链接，改动无需重装即可生效。`file:` 与 `github:`
两种 spec 会互相替换，验证发布前记得切回 `github:`。

## 许可

MIT
