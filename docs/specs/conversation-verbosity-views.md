# 会话消息流详略视图(Verbosity Views)设计

> 状态:已实施。参照对象为 Claude Code Desktop 的 "Transcript view"(Normal / Thinking /
> Verbose,Summary 已在其 1.46388.1 弃用);本规格定义 ZCode 自己的三档详略 + 独立
> 「默认展开」开关,两份偏好都要求**回溯生效**(切换后作用于全部历史 turn,不只是未来输出)。

## 1. 第一性原理

1. **投影是唯一事实,视图是派生态。** 详略档位与展开默认值只改变渲染派生
   (`buildConversationTurnRenderUnits` + `ToolLayout` 初始态),绝不写回 conversation
   rows / snapshot。任何档位切换都必须无损可逆。
2. **回溯是构造出来的,不是补出来的。** 渲染管线是 rows + options 的纯函数;
   切换偏好 ⇒ options 变 ⇒ 全部 render units 重推导 ⇒ 已挂载组件同步新默认值。
   不允许出现「旧 turn 记住旧档位」的持久化状态。
3. **事实源唯一。** 两个偏好都是 user-scope app settings
   (`messageStreamVerbosity` / `messageStreamExpandedByDefault`),
   由 SettingsService 持久化;渲染层只读,不设第二份真值。
4. **自动展开语义与用户偏好语义分层。** `forceOpen`(异常历史、运行态)锁定卡片,
   偏好只改变**初始**展开态;用户对单张卡 / 单个 turn 的手动开合仍可覆盖偏好,
   但偏好切换时手动覆盖被重置(epoch),保证回溯完整。
5. **档位决定「可见什么」,开关决定「初始展开吗」。** 两个控制正交:
   verbose 也可以初始折叠,normal 也可以默认全展开。
6. **「默认展开」作用于消息流里的全部可折叠内容,不只工具卡。** 开关打开 ⇒
   工具卡(ToolLayout,含 edit diff 预览与 execute/changes/cua 分组卡)、
   思考块(Reasoning)、轮尾文件变更摘要(ConversationFileSummaryPanel)、
   已完成轮「已工作」历史区,全部以展开为初始态。开关**不改变可见性**:
   被档位或逐项设置隐藏的内容(summary 的 reasoning、`messageStreamShowReasoning=false`)
   不会因开关复活。

## 2. 档位与开关的行为定义

### messageStreamVerbosity: "summary" | "normal" | "verbose"(默认 normal)

| 档位 | 用户输入 | 中间工作(工具/子代理/reasoning) | 回复正文 | 轮级聚合 |
| --- | --- | --- | --- | --- |
| summary | 显示 | 「已工作 Ns」折叠区强制收起(Radix 关闭即卸载,不渲染内容);reasoning 一律隐藏 | 显示(每轮最终正文) | 文件 summary、workflow 完成卡、Cron/OffPeak 卡照常 |
| normal | 显示 | 现状:工具摘要行可开合,reasoning 跟随 `messageStreamShowReasoning` | 显示 | 照常 |
| verbose | 显示 | 同 normal,且 reasoning 视为显示(等价 `messageStreamShowReasoning=true`,与 Claude Code Verbose 含 thinking 一致) | 显示 | 照常 |

### messageStreamExpandedByDefault: boolean(默认 false)

- `true`:消息流中所有可折叠内容默认展开——工具卡(ToolLayout,含分组卡与卡内
  diff 预览)、思考块(Reasoning)、轮尾文件变更摘要面板、已完成轮「已工作」历史区。
- `false`:现状(默认收起)。
- 生效默认 `expandAll = (verbosity === "verbose") || switch`,由 SessionPane 单点解析后
  写入 `conversationExpandDefaultStore`;render units 走 options(`expandAllByDefault`)。
- 该开关**不锁定**:由偏好打开的折叠区允许用户手动收起;`forceOpen`
  (异常历史/运行态锁死)语义保持不变。
- 开关打开时 thinking 块的「完成自动收起」(`autoCollapseKey`)被禁用——用户明确
  要求展开,自动收起会与偏好对抗;开关关闭时保持原有 streaming→complete 收起行为。

### 解析规则(单点,禁止多处复写)

```
showReasoning.effective = verbosity === "verbose"
                       || (verbosity !== "summary" && messageStreamShowReasoning)
expandAll = messageStreamExpandedByDefault || verbosity === "verbose"
historyDefaultOpen.effective(已完成 turn) = expandAll
summary 档位: historyDefaultOpen 一律 false(内容不挂载)
toolCard defaultOpen = expandAll          (ToolLayout 订阅 store)
reasoning defaultOpen = expandAll         (仅对可见的 reasoning 行;ReasoningRowView)
reasoning autoCollapseKey = expandAll ? null : (streaming ? null : row.state)
fileSummaryPanel defaultOpen = expandAll  (ConversationFileSummaryPanel 订阅 store)
```

## 3. 状态所有权

```
SettingsService (user-scope, 持久化)
  ├─ messageStreamVerbosity ─────┐
  └─ messageStreamExpandedByDefault
         │ useSettings()
         ▼
  SessionPane(读值 + 注入)
         ├─ rowContext.messageStreamVerbosity / .messageStreamExpandedByDefault
         │     └─ ConversationTimeline → buildConversationTurnRenderUnits options
         │           └─ 纯函数重推导全部 turn units(回溯路径 A)
         │                 └─ ConversationWorkSegmentFlow: defaultOpen vs lockedOpen 分离
         └─ conversationExpandDefaultStore { defaultOpen, epoch }(回溯路径 B)
               ├─ ToolLayout 订阅:初始 isOpen = overrideMap.get(toolId) ?? defaultOpen
               │     epoch 变化 ⇒ overrideMap.clear() + 全部卡片重置新默认值
               ├─ ReasoningRowView 订阅:defaultOpen 进 Reasoning;epoch 变化 ⇒
               │     以 epoch 为 key 重挂载,回溯重置(含手动开合)
               └─ ConversationFileSummaryPanel 订阅:初始 open = defaultOpen;
                     epoch 变化 ⇒ setOpen(defaultOpen)(手动开合随代际重置)
```

- `toolLayoutOpenState`(按 toolId 的 Map)降级为「本次偏好代际内的手动覆盖」;
  偏好切换 ⇒ epoch 递增 ⇒ 覆盖清空 ⇒ 回溯重置。Reasoning / FileSummaryPanel 的
  手动开合是组件内局部状态,重挂载 / epoch 效果即完成同等重置。
- `autoOpen`(edit/read 运行中自动展开)与 `autoCollapseOnComplete` 生命周期效果
  保持原语义,继续写入 overrideMap(它们是事实性的运行态,不是偏好)。

## 4. 事件顺序(切换 verbose → 回溯展开)

```
用户在会话头部切到 verbose(或打开「默认展开全部」)
  → updateSharedSettings({ messageStreamVerbosity: "verbose" })
    → SettingsService 落盘 + 通知
      → SessionPane 重渲染:rowContext 新值 + conversationExpandDefaultStore.set(true, epoch+1)
        → A) renderUnits 重推导:全部已完成 turn historyDefaultOpen=true
             → ConversationWorkSegmentFlow useEffect 同步 historyOpen(旧逻辑复用)
        → B) ToolLayout 订阅回调:overrideMap.clear();setIsOpen(true)
        → B') ReasoningRowView:epoch key 变化 ⇒ Reasoning 重挂载,defaultOpen=true
        → B'') ConversationFileSummaryPanel:epoch 效果 ⇒ setOpen(true)
        → 用户手动再收起某卡/某块 ⇒ 记录为局部手动态(仅本代际有效)
```

## 5. 边界与不变量

- **分享只读时间线**(`ConversationShareReadonlyTimeline`)不带偏好 ⇒ 行为不变。
- **手机远控**走同一 SessionPane/rowContext,自动继承;compact 模式不受影响。
- **协议零改动**:纯 renderer + user settings,不新增 RPC、不改 zcode-protocol。
- **异常历史**(`forceOpenHistory`:interrupted/failed)优先级高于档位——summary 也不收起
  异常轮的上下文(诊断信息不可被档位隐藏)。
- **summary 档位的 reasoning**:即便 `messageStreamShowReasoning=true` 也不显示
  (档位语义优先);首条 reasoning 展示豁免(`messageStreamFirstReasoningRowId`)同样关闭。
- **带 summaryAction 的卡片**(插件声明)与 summary-only 生命周期卡不参与开合,照旧。
- **开关不改变可见性**:normal 档且 `messageStreamShowReasoning=false` 时,开关打开
  也不会让 thinking 复活(可见性归档位与逐项设置所有,展开归开关所有)。
- **插件卡片固定/收起**(`pluginUiDisclosureStore`)与状态面板、分享时间线不参与
  开关:插件 pin 有独立语义(强制常驻/近三回合自动展开),不与视图偏好耦合。
- **内存**:overrideMap 清空在 epoch 切换时顺带回收;继续登记
  uiMemoryDiagnosticsRegistry。

## 6. 验收场景

1. 三轮对话(含工具/reasoning)完成后切 summary:每轮只剩输入 + 最终正文 +
   「已工作」收起头;DOM 中不再挂载中间行;切回 normal 内容完整恢复(无损)。
2. 同一会话切 verbose:reasoning 出现、全部已完成轮工作区展开、工具卡片初始展开;
   单卡可手动收起。
3. 开关 on + normal:工具卡片、思考块、轮尾文件摘要与工作区默认展开;
   reasoning 可见性仍跟随原设置;streaming 思考块完成后不再自动收起。
4. 开关 on → off 回溯:全部思考块/文件摘要面板随 epoch 重置回收起;
   工具卡手动覆盖一并清空。
5. 任意切换后新增的 turn:按新档位渲染(无「新旧档位混排」)。
6. 异常中断轮在任何档位保持展开(诊断上下文可见)。
7. 运行中切档位:live turn 的运行态(loading、扫光、autoOpen)不受影响。
8. 分享页与只读会话行为不随档位变化。
