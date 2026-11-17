import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import type { BackgroundToolSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

type BackgroundToolDetailStatus = "running" | "success" | "error" | "cancelled";

/** `h:mm:ss` / `m:ss`; a foreground-card elapsed label is not reusable here (private). */
function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

const BackgroundToolDetailContent = memo(function BackgroundToolDetailContent({
  tab,
  visible,
}: {
  tab: BackgroundToolSidePaneTab;
  visible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // The live detail is part of the parent session's authoritative projection (same pattern as
  // the workflow run pane), not a local query cache.
  useEffect(() => {
    const nextLease = layer.acquire(tab.sessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.sessionId]);

  const state = useConversationProjection(lease);
  const liveWork = state.snapshot?.backgroundWorks.find((work) => work.workId === tab.workId);
  // The work entry disappears once the background result is delivered. Keep the last snapshot
  // in a ref so the final text and status stay on screen instead of blanking out.
  const lastWorkRef = useRef<BackgroundWorkSummary | null>(liveWork ?? null);
  if (liveWork) lastWorkRef.current = liveWork;
  const work = liveWork ?? lastWorkRef.current;
  const detail = work?.liveDetail ?? null;
  const status: BackgroundToolDetailStatus | "loading" = detail?.tool?.status
    ? detail.tool.status
    : work
      ? work.status === "running"
        ? "running"
        : "success"
      : "loading";
  const running = status === "running";

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || !running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, running]);

  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    if (!visible || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    previousTop.current = scroll.current.scrollTop;
  }, [visible, following, detail?.text]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case "running":
        return intl.formatMessage({ id: "backgroundTool.status.running" });
      case "success":
        return intl.formatMessage({ id: "backgroundTool.status.success" });
      case "error":
        return intl.formatMessage({ id: "backgroundTool.status.error" });
      case "cancelled":
        return intl.formatMessage({ id: "backgroundTool.status.cancelled" });
      default:
        return "";
    }
  }, [intl, status]);
  const elapsedMs = Math.max(0, now - (work?.startedAt ?? detail?.updatedAt ?? now));

  return (
    <section
      data-testid="background-tool-details"
      data-work-id={tab.workId}
      data-status={status}
      data-following={following}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel text-ui-base text-foreground-subtle"
    >
      {state.status === "error" ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 px-4 py-2 text-danger">
          <span>{state.lastError}</span>
        </div>
      ) : null}
      <div
        data-testid="background-tool-statusbar"
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 text-ui-sm"
      >
        <span
          role="status"
          data-testid="background-tool-status"
          className="flex shrink-0 items-center gap-2"
        >
          {running ? <LoaderCircle className="size-3 animate-spin" /> : null}
          {statusLabel ? <span>{statusLabel}</span> : null}
          {running ? <span className="tabular-nums">{formatElapsed(elapsedMs / 1000)}</span> : null}
        </span>
        {detail?.truncated ? (
          <span data-testid="background-tool-truncated" className="text-ui-sm">
            {intl.formatMessage({ id: "backgroundTool.truncated" })}
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <ScrollFadeViewport
          ref={scroll}
          data-testid="background-tool-scroll"
          className="h-full overflow-auto px-4 py-3"
          tabIndex={0}
          onScroll={(event) => {
            if (!visible) return;
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
            if (following && el.scrollTop < previousTop.current && !atBottom) {
              setFollowing(false);
              logger.debug("Background tool detail following changed", {
                workId: tab.workId,
                following: false,
              });
            } else if (!following && atBottom) {
              // Reaching the bottom by hand resumes following, otherwise the floating arrow
              // would stay forever even though nothing is left below.
              setFollowing(true);
              logger.debug("Background tool detail following changed", {
                workId: tab.workId,
                following: true,
              });
            }
            previousTop.current = el.scrollTop;
          }}
        >
          <pre
            data-testid="background-tool-output"
            className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5"
          >
            {detail?.text || (detail ? "" : intl.formatMessage({ id: "backgroundTool.empty" }))}
          </pre>
        </ScrollFadeViewport>
        {!following ? (
          <Button
            variant="outline"
            size="icon"
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-sm hover:bg-card-selected"
            data-testid="background-tool-resume"
            aria-label={intl.formatMessage({ id: "chat.scrollToBottom" })}
            title={intl.formatMessage({ id: "chat.scrollToBottom" })}
            onClick={() => setFollowing(true)}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </section>
  );
});

/**
 * Live-detail side tab for a background tool work (Task Island "Tools" section).
 *
 * Mirrors `BackgroundBashOutputSidePane`'s follow/pause behavior, but the data comes from the
 * conversation projection: `backgroundWorks[workId].liveDetail` is the bounded runtime mirror,
 * so there is no query cache and no extra command surface.
 */
export const BackgroundToolDetailSidePane = memo(function BackgroundToolDetailSidePane({
  tab,
  visible,
}: {
  tab: BackgroundToolSidePaneTab;
  visible: boolean;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <BackgroundToolDetailContent tab={tab} visible={visible} />
    </V4PaneConversationProvider>
  );
});
