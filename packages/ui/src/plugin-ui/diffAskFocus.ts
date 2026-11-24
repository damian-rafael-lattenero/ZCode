// diff-ask focus handoff (fork, 2026-11-24): the end-of-turn file summary
// opens the Diff Ask panel; the clicked file must arrive as its FOCUS, so the
// plugin expands only that file and collapses the rest.
//
// The host's panel bridge can only call a surface's server tool through the
// RUNNING page instance (see officeViewerOpen.ts for the same pattern:
// `callPanelTool`). Opening a side-pane tab is async (sandbox prepare +
// handshake), so the click parks the file here and the side-pane model
// delivers it as soon as the page reaches phase "running".
//
// The plugin side owns the contract: `get_turn_diff { turn, focus }` parks a
// one-shot focus (30 s TTL) and notifies the panel, whose next turn read
// resolves it (`focusPath`) and collapses every other section.
import { pluginUiPages } from "@/plugin-ui/adapters/pluginUiPageRegistry.js";
import { logger } from "@/logger.js";

/** Same budget as the office viewer: a sandbox that never starts must not keep a stale focus. */
const DIFF_ASK_FOCUS_TTL_MS = 30_000;
const DIFF_ASK_TOOL = "get_turn_diff";

interface DiffAskPendingFocus {
  path: string;
  turn: string;
  at: number;
}

const pendingByTabId = new Map<string, DiffAskPendingFocus>();
const listenersByTabId = new Map<string, Set<() => void>>();

function notify(tabId: string): void {
  for (const listener of listenersByTabId.get(tabId) ?? []) listener();
}

/** Park the clicked file for the tab that was just opened (newest click wins). */
export function requestDiffAskFocus(tabId: string, filePath: string, turn = "latest"): void {
  const path = String(filePath ?? "").trim();
  if (!tabId || !path) return;
  pendingByTabId.set(tabId, { path, turn, at: Date.now() });
  notify(tabId);
}

/** The side-pane model subscribes and re-delivers on every page phase change. */
export function subscribeDiffAskFocus(tabId: string, listener: () => void): () => void {
  const listeners = listenersByTabId.get(tabId) ?? new Set();
  listeners.add(listener);
  listenersByTabId.set(tabId, listeners);
  listener();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) listenersByTabId.delete(tabId);
  };
}

/**
 * Deliver the parked focus once the panel can take tool calls (phase
 * "running"). Returns whether a call was started. A tool error is logged and
 * the panel simply stays where it is — the file click already opened it.
 */
export function deliverDiffAskFocusIfReady(tabId: string, pageKey: string): boolean {
  const pending = pendingByTabId.get(tabId);
  if (!pending) return false;
  if (Date.now() - pending.at > DIFF_ASK_FOCUS_TTL_MS) {
    pendingByTabId.delete(tabId);
    return false;
  }
  const page = pluginUiPages.get(pageKey);
  if (!page || page.snapshot().phase !== "running") return false;
  // Atomic take: a repeated phase/visibility edge never focuses twice.
  pendingByTabId.delete(tabId);
  void (async () => {
    try {
      const result = await page.callPanelTool(DIFF_ASK_TOOL, {
        turn: pending.turn,
        focus: pending.path,
      });
      if (result.isError) {
        logger.warn("[diff-ask] get_turn_diff(focus) returned an error", {
          path: pending.path,
        });
      }
    } catch (error) {
      logger.warn("[diff-ask] get_turn_diff(focus) failed", {
        path: pending.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;
}
