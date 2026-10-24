/**
 * 消息流「默认展开全部」偏好的运行时镜像（spec：docs/specs/conversation-verbosity-views.md）。
 *
 * 事实源是 user-scope app settings 的 messageStreamExpandedByDefault 与
 * messageStreamVerbosity==="verbose" 的或值；SessionPane（消息流宿主）是唯一写入方，
 * 把解析结果同步进来。订阅方是消息流里所有带「初始展开态」的折叠内容：
 * ToolLayout 工具卡、ReasoningRowView 思考块、ConversationFileSummaryPanel 轮尾
 * 文件摘要——避免把偏好穿透 30+ renderer 与逐行组件。
 *
 * epoch 语义：偏好翻转时递增。已挂载组件据此清掉手动覆盖并重置到新默认值
 * （ToolLayout 清空 overrideMap；Reasoning 按 epoch 重挂载；FileSummaryPanel 重置
 * open）——「回溯生效」要求切换瞬间作用于全部历史内容，而手动覆盖只在本偏好
 * 代际内有效。值未变化时不递增、不通知，避免无谓的全量重渲染。
 */
export interface ConversationExpandDefaultState {
  defaultOpen: boolean;
  epoch: number;
}

const listeners = new Set<() => void>();
let state: ConversationExpandDefaultState = { defaultOpen: false, epoch: 0 };

export function getConversationExpandDefaultSnapshot(): ConversationExpandDefaultState {
  return state;
}

export function subscribeConversationExpandDefault(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 唯一写入方（SessionPane）调用；值不变为 no-op。 */
export function setConversationExpandDefault(defaultOpen: boolean): void {
  if (state.defaultOpen === defaultOpen) return;
  state = { defaultOpen, epoch: state.epoch + 1 };
  for (const listener of listeners) listener();
}

/** 测试用：重置为初始快照。 */
export function resetConversationExpandDefaultForTest(): void {
  state = { defaultOpen: false, epoch: 0 };
  listeners.clear();
}
