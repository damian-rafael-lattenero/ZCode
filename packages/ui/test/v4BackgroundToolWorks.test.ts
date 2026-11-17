/** @vitest-environment jsdom */

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "./fork-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_BACKGROUND_WORK_ITEM, testId } from "@zcode/shared/test-ids";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/GitActionMenu.js", () => ({
  GitActionMenu: () => createElement("div", { "data-testid": "mock-git-action-menu" }),
}));

vi.mock("@/GitBranchSwitcher.js", () => ({
  GitBranchSwitcher: () => createElement("div", { "data-testid": "mock-git-branch-switcher" }),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

const runningToolWork: BackgroundWorkSummary = {
  workId: "exec_tool_1",
  kind: "tool",
  title: "Search the docs",
  status: "running",
  startedAt: 1_700_000_000_000,
  cancellable: true,
  anchorRowId: null,
};

// Only getByTestId exists in fork-testing; absence assertions use the same filter.
function queryByTestId(id: string): Element | null {
  return (
    Array.from(document.body.querySelectorAll("[data-testid]")).find(
      (element) => element.getAttribute("data-testid") === id,
    ) ?? null
  );
}

async function renderPanel(options: {
  onOpenBackgroundTool?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
}) {
  const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");
  return render(
    createElement(ConversationStatusPanel, {
      workspacePath: "/repo",
      backgroundWorks: [runningToolWork],
      summaryPanelVariantOverride: "panel",
      toolSectionOpen: true,
      onToolSectionOpenChange: vi.fn(),
      ...options,
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("ConversationStatusPanel tools section", () => {
  it("renders a row for each running tool work with title, elapsed and cancel", async () => {
    await renderPanel({ onCancelBackgroundWork: vi.fn() });

    const row = screen.getByTestId(testId(TID_V4_BACKGROUND_WORK_ITEM, runningToolWork.workId));
    expect(row.getAttribute("data-background-task-kind")).toBe("tool");
    expect(row.getAttribute("data-work-status")).toBe("running");
    expect(row.textContent).toContain(runningToolWork.title);
    expect(screen.getByTestId(testId("v4-background-work-cancel", runningToolWork.workId))).toBeTruthy();
  });

  it("clicking the transparent overlay hands the work to onOpenBackgroundTool", async () => {
    const onOpenBackgroundTool = vi.fn();
    await renderPanel({ onOpenBackgroundTool });

    fireEvent.click(screen.getByTestId("background-tool-open"));

    expect(onOpenBackgroundTool).toHaveBeenCalledTimes(1);
    expect(onOpenBackgroundTool).toHaveBeenCalledWith(runningToolWork);
  });

  it("has no overlay button when the host provides no open callback", async () => {
    await renderPanel({ onCancelBackgroundWork: vi.fn() });

    expect(queryByTestId("background-tool-open")).toBeNull();
  });

  it("cancel is a separate control and does not trigger the open callback", async () => {
    const onOpenBackgroundTool = vi.fn();
    const onCancelBackgroundWork = vi.fn();
    await renderPanel({ onOpenBackgroundTool, onCancelBackgroundWork });

    fireEvent.click(screen.getByTestId(testId("v4-background-work-cancel", runningToolWork.workId)));

    expect(onCancelBackgroundWork).toHaveBeenCalledWith(runningToolWork.workId);
    expect(onOpenBackgroundTool).not.toHaveBeenCalled();
  });
});

describe("ConversationBackgroundWorkTrigger tool count", () => {
  it("counts tool works in the badge and lights the badge on tools alone", async () => {
    const { ConversationBackgroundWorkTrigger } = await import(
      "@/v4/composer/ConversationBackgroundWorkTrigger.js"
    );
    const onOpen = vi.fn();
    render(
      createElement(ConversationBackgroundWorkTrigger, {
        backgroundWorks: [runningToolWork],
        onOpen,
      }),
    );

    const trigger = screen.getByTestId("v4-composer-background-work-trigger");
    expect(trigger.getAttribute("data-background-tool-count")).toBe("1");
    expect(trigger.getAttribute("data-background-total-count")).toBe("1");

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
