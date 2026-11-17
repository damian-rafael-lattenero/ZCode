import { useEffect, useState } from "react";
import { PictureInPicture2Icon } from "lucide-react";
import { TID_V4_TOOL_BACKGROUND, testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * How long a row must stay continuously running before the per-tool entry appears.
 * The delay exists to keep fast tool calls from flashing a detach affordance.
 */
export const PILL_DELAY_MS = 2500;

/**
 * Gate for the per-tool "Go to background" pill (v4 `backgroundToolCall`).
 *
 * `raw.backgroundable` is the host-authoritative capability: only tools the runtime
 * can actually detach opt in (AskUserQuestion, MCP and legacy rows never do). The
 * running fact comes from `raw.v4Status`, not the legacy `isRunning`: the legacy flag
 * also covers pending rows (streaming input / approval), and those have no execution
 * yet to detach. Once the projection flips the row to `backgrounded: true` the pill
 * disappears. Office mode is read-only by contract, so it never gets the entry either.
 */
export function canBackgroundToolCall(
  raw: unknown,
  hasHandler: boolean,
  isOfficeMode: boolean,
): boolean {
  if (!hasHandler || isOfficeMode) return false;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    record.backgroundable === true && record.v4Status === "running" && record.backgrounded !== true
  );
}

export interface ToolBackgroundButtonProps {
  toolCallId: string;
  onBackgroundToolCall: (toolCallId: string) => void;
}

/**
 * Single-tool demotion pill rendered as a sibling directly below the tool card
 * (same placement contract as ToolSnapshotFieldNotice: it does not hide with the
 * collapsed body). Different granularity from the turn-level pill: this detaches
 * one tool call, the turn pill detaches the whole running primaryTurn.
 *
 * The uninterruption clock starts on mount: the parent gate only mounts this
 * component while the row is running and backgroundable, and unmounts it the moment
 * the row leaves `running` or flips to `backgrounded`, so a remount always restarts
 * the 2.5s window.
 */
export function ToolBackgroundButton({
  toolCallId,
  onBackgroundToolCall,
}: ToolBackgroundButtonProps) {
  const { intl } = useZCodeIntl();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setArmed(true);
    }, PILL_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  if (!armed) return null;

  return (
    <div className="mt-1 flex justify-center">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="rounded-full gap-1.5"
        onClick={() => onBackgroundToolCall(toolCallId)}
        data-testid={testId(TID_V4_TOOL_BACKGROUND, toolCallId)}
      >
        <PictureInPicture2Icon className="size-3.5" />
        <span>{intl.formatMessage({ id: "chat.timeline.backgroundTurn" })}</span>
      </Button>
    </div>
  );
}
