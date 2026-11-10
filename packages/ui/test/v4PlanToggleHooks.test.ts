// @vitest-environment jsdom

// (FORK) The plan toggle must survive EVERY state transition the real app can
// throw at it — the press sequence (draft flip), the mirror adoption (mode
// re-stamp), the pending-snapshot gap (mode undefined ↔ defined) and the
// disabled flip. React #301 in production had no renderer logs, so this test
// is the crash's proof: dev React names any hooks-order violation here.

import type { ReactNode } from "react";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, fireEvent, screen } from "./fork-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

afterEach(cleanup);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// useShortcutCommandLabel → useSettings only reads settingService.get(); a
// minimal stub keeps the harness free of the real service graph.
const STUB_SERVICES = {
  settingService: { get: async () => ({}), update: async () => {} },
} as unknown as IServiceAccessor;

// useSettings also reads the platform for the cache key; a hollow platform is
// enough for the shortcut-label path under test.
const STUB_PLATFORM = {} as unknown as Parameters<typeof PlatformProvider>[0]["platform"];

type DraftConfig = {
  mode?: string;
  planEnabled?: boolean;
};

type SwitchProps = {
  draftConfig?: DraftConfig;
  disabled?: boolean;
  onSwitchMode: (mode: string) => void;
};

function Harness(props: { bag: SwitchProps }): ReactNode {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(
      PlatformProvider,
      { platform: STUB_PLATFORM },
      createElement(
        TooltipProvider,
        null,
        createElement(
          ServiceProvider,
          { services: STUB_SERVICES },
          createElement(V4ComposerModeSwitch, {
            provider: undefined,
            draftConfig: props.bag.draftConfig,
            disabled: props.bag.disabled ?? false,
            activeConfigPicker: null,
            onConfigPickerOpenChange: () => {},
            onSwitchMode: props.bag.onSwitchMode,
          }),
        ),
      ),
    ),
  );
}

// A root whose bag can be replaced: each mount() re-renders the SAME fiber —
// exactly what the app does when the draft or the projection updates.
function createHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const mount = (bag: SwitchProps) => {
    act(() => {
      root.render(createElement(Harness, { bag }));
    });
  };
  return {
    mount,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// fork-testing only exports getByTestId (presence assertion); the absence
// check mirrors the local helper pattern of v4ToolBackgroundButton.test.ts.
function queryByTestId(id: string): Element | null {
  return (
    Array.from(document.body.querySelectorAll("[data-testid]")).find(
      (element) => element.getAttribute("data-testid") === id,
    ) ?? null
  );
}

const HOOKS_ERROR = /Minified React error #3|Rendered (fewer|more) hooks|hooks/i;

function assertNoHookErrors(spy: ReturnType<typeof vi.spyOn>): void {
  const reactErrors = spy.mock.calls.filter((args) =>
    args.some((arg) => typeof arg === "string" && HOOKS_ERROR.test(arg)),
  );
  expect(reactErrors).toEqual([]);
}

describe("plan toggle: every state arc keeps the fiber's hooks stable", () => {
  it("press sequence (draft flip + mirror adoption) never crashes", () => {
    const onSwitchMode = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness();

    try {
      harness.mount({ draftConfig: { mode: "yolo", planEnabled: false }, onSwitchMode });

      const toggle = screen.getByTestId("v4-composer-plan-toggle");
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(toggle);
      expect(onSwitchMode).toHaveBeenCalledWith("plan");

      // 2nd render: the draft-side update (planEnabled only — mode untouched).
      harness.mount({ draftConfig: { mode: "yolo", planEnabled: true }, onSwitchMode });
      expect(screen.getByTestId("v4-composer-plan-toggle").getAttribute("aria-pressed")).toBe(
        "true",
      );

      // 3rd render: the projection adoption re-stamps mode (plan → build).
      harness.mount({ draftConfig: { mode: "build", planEnabled: true }, onSwitchMode });

      // Toggle off arc.
      fireEvent.click(screen.getByTestId("v4-composer-plan-toggle"));
      expect(onSwitchMode).toHaveBeenLastCalledWith("plan-off");
      harness.mount({ draftConfig: { mode: "build", planEnabled: false }, onSwitchMode });
      harness.mount({ draftConfig: { mode: "yolo", planEnabled: false }, onSwitchMode });

      assertNoHookErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
      harness.unmount();
    }
  });

  it("pending-snapshot gap (mode undefined ↔ defined) never crashes", () => {
    const onSwitchMode = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness();

    try {
      // A live session before its first config snapshot: draftConfig.mode is
      // undefined — the toggle STILL speaks (owner's law: always visible);
      // only the permission menu waits for a selected mode.
      harness.mount({ draftConfig: { planEnabled: false }, onSwitchMode });
      const pendingToggle = queryByTestId("v4-composer-plan-toggle");
      expect(pendingToggle === null).toBe(false);
      expect(pendingToggle?.getAttribute("aria-pressed")).toBe("false");
      expect(queryByTestId("chat-mode-select-trigger") === null).toBe(true);

      // The first snapshot lands: mode becomes defined (selected flips null↔button).
      harness.mount({ draftConfig: { mode: "yolo", planEnabled: false }, onSwitchMode });

      // And back to pending (session re-open, snapshot not yet restored).
      harness.mount({ draftConfig: { planEnabled: true }, onSwitchMode });
      harness.mount({ draftConfig: { mode: "build", planEnabled: true }, onSwitchMode });

      assertNoHookErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
      harness.unmount();
    }
  });

  it("disabled flip while plan is armed never crashes", () => {
    const onSwitchMode = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness();

    try {
      harness.mount({ draftConfig: { mode: "yolo", planEnabled: false }, onSwitchMode });
      harness.mount({
        draftConfig: { mode: "yolo", planEnabled: false },
        disabled: true,
        onSwitchMode,
      });
      harness.mount({
        draftConfig: { mode: "yolo", planEnabled: true },
        disabled: true,
        onSwitchMode,
      });
      harness.mount({
        draftConfig: { mode: "build", planEnabled: true },
        disabled: false,
        onSwitchMode,
      });

      assertNoHookErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
      harness.unmount();
    }
  });
});
