// @vitest-environment jsdom

import { useState, type ChangeEvent } from "react";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "./fork-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_COMPOSER_INTERRUPT_PICKER,
  TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT,
  TID_COMPOSER_INTERRUPT_PICKER_QUEUE,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerInterruptPicker } from "@/v4/composer/ComposerInterruptPickerStrip.js";
import {
  isInterruptSteerOffered,
  shouldOfferComposerInterruptPicker,
  useComposerInterruptPickerController,
  type ComposerInterruptPickerGate,
} from "@/v4/composer/composerInterruptPicker.js";

// Busy composer "Cut and continue / Queue" picker.
// DOM contract: the strip lives in the composer surface above the input and never
// clears or sends anything on its own; only an explicit option click dispatches.
// The harness below mirrors the composer seam: submit -> controller.request(gate)
// -> inline picker -> controller.select -> delivery forwarded as requestedDelivery.

afterEach(cleanup);

function queryByTestId(id: string): Element | null {
  return (
    Array.from(document.body.querySelectorAll("[data-testid]")).find(
      (element) => element.getAttribute("data-testid") === id,
    ) ?? null
  );
}

function composeGate(
  overrides: Partial<ComposerInterruptPickerGate> = {},
): ComposerInterruptPickerGate {
  return {
    canSend: true,
    canStop: true,
    activeWorks: [{ kind: "primaryTurn" }],
    inputRoutingMode: "startNow",
    heldQueueConfirmationOpen: false,
    explicitDeliveryOverride: false,
    ...overrides,
  };
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

function renderPicker(options: {
  interruptAllowed: boolean;
  onSelect: () => void;
  onDismiss: () => void;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ComposerInterruptPicker, {
        interruptAllowed: options.interruptAllowed,
        onSelect: options.onSelect,
        onDismiss: options.onDismiss,
      }),
    ),
  );
}

describe("composer interrupt picker gating", () => {
  it("opens for a running primary turn", () => {
    expect(shouldOfferComposerInterruptPicker(composeGate())).toBe(true);
  });

  it("stays closed when the session is idle or detached (canStop false)", () => {
    expect(shouldOfferComposerInterruptPicker(composeGate({ canStop: false }))).toBe(false);
    expect(
      shouldOfferComposerInterruptPicker(composeGate({ canStop: false, activeWorks: [] })),
    ).toBe(false);
  });

  it("stays closed while compact owns the foreground", () => {
    expect(
      shouldOfferComposerInterruptPicker(
        composeGate({ canStop: false, activeWorks: [{ kind: "compact" }] }),
      ),
    ).toBe(false);
  });

  it("stays closed without a primary turn in activeWorks", () => {
    expect(
      shouldOfferComposerInterruptPicker(
        composeGate({ activeWorks: [{ kind: "foregroundSubagent" }] }),
      ),
    ).toBe(false);
  });

  it("stays closed in paused-queue choice mode", () => {
    expect(shouldOfferComposerInterruptPicker(composeGate({ inputRoutingMode: "choice" }))).toBe(
      false,
    );
  });

  it("stays closed while the held-queue confirmation dialog is open", () => {
    expect(
      shouldOfferComposerInterruptPicker(composeGate({ heldQueueConfirmationOpen: true })),
    ).toBe(false);
  });

  it("stays closed when a modifier or an explicit delivery already decided", () => {
    expect(
      shouldOfferComposerInterruptPicker(composeGate({ explicitDeliveryOverride: true })),
    ).toBe(false);
  });

  it("stays closed when the draft is not sendable", () => {
    expect(shouldOfferComposerInterruptPicker(composeGate({ canSend: false }))).toBe(false);
  });
});

describe("composer interrupt picker controller", () => {
  it("request opens only for a running primary turn and select forwards interrupt", () => {
    const onDeliver = vi.fn();
    const { result } = renderHook(() => useComposerInterruptPickerController({ onDeliver }));

    let intercepted = false;
    act(() => {
      intercepted = result.current!.request(composeGate())!;
    });
    expect(intercepted).toBe(true);
    expect(result.current!.open).toBe(true);

    act(() => {
      result.current!.select("interrupt");
    });
    expect(onDeliver).toHaveBeenCalledWith("interrupt");
    expect(result.current!.open).toBe(false);
  });

  it("request does not open while idle and select queue forwards queue", () => {
    const onDeliver = vi.fn();
    const { result } = renderHook(() => useComposerInterruptPickerController({ onDeliver }));

    let intercepted = true;
    act(() => {
      intercepted = result.current!.request(composeGate({ canStop: false }))!;
    });
    expect(intercepted).toBe(false);
    expect(result.current!.open).toBe(false);

    act(() => {
      result.current!.request(composeGate())!;
    });
    act(() => {
      result.current!.select("queue");
    });
    expect(onDeliver).toHaveBeenCalledWith("queue");
  });

  it("dismiss closes without delivering", () => {
    const onDeliver = vi.fn();
    const { result } = renderHook(() => useComposerInterruptPickerController({ onDeliver }));

    act(() => {
      result.current!.request(composeGate())!;
    });
    act(() => {
      result.current!.dismiss();
    });
    expect(onDeliver).not.toHaveBeenCalled();
    expect(result.current!.open).toBe(false);
  });
});

describe("composer interrupt picker strip", () => {
  it("renders both options for a running turn", () => {
    renderPicker({ interruptAllowed: true, onSelect: () => {}, onDismiss: () => {} });
    expect(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER)).toBeTruthy();
    expect(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT)).toBeTruthy();
    expect(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_QUEUE)).toBeTruthy();
  });

  it("interrupt click dispatches the interrupt delivery", () => {
    const onSelect = vi.fn();
    renderPicker({ interruptAllowed: true, onSelect, onDismiss: () => {} });
    fireEvent.click(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT));
    expect(onSelect).toHaveBeenCalledWith("interrupt");
  });

  it("queue click dispatches the queue delivery", () => {
    const onSelect = vi.fn();
    renderPicker({ interruptAllowed: true, onSelect, onDismiss: () => {} });
    fireEvent.click(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_QUEUE));
    expect(onSelect).toHaveBeenCalledWith("queue");
  });

  it("hides the interrupt option when availability denies it", () => {
    const onSelect = vi.fn();
    renderPicker({ interruptAllowed: false, onSelect, onDismiss: () => {} });
    expect(queryByTestId(TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT)).toBeNull();
    fireEvent.click(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_QUEUE));
    expect(onSelect).toHaveBeenCalledWith("queue");
  });

  it("Escape dismisses without selecting or sending", () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    renderPicker({ interruptAllowed: true, onSelect, onDismiss });
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("treats a missing availability field as allowed for old frames", () => {
    expect(isInterruptSteerOffered({ allowed: true })).toBe(true);
    expect(isInterruptSteerOffered({ allowed: false, reasonCode: "x" })).toBe(false);
    expect(isInterruptSteerOffered(undefined)).toBe(true);
  });
});

// Mirrors the composer seam: the draft lives outside the picker, submit opens it,
// and only a confirmed option sends. Dismissal must leave the draft untouched.
function PickerHarness(props: {
  onSend: (delivery: "interrupt" | "queue", draft: string) => void;
}) {
  const [draft, setDraft] = useState("keep me");
  const controller = useComposerInterruptPickerController({
    onDeliver: (delivery) => props.onSend(delivery, draft),
  });
  return createElement(
    "div",
    null,
    createElement("textarea", {
      "aria-label": "draft",
      value: draft,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    }),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "harness-send",
        onClick: () => {
          controller.request(composeGate());
        },
      },
      "send",
    ),
    controller.open
      ? createElement(ComposerInterruptPicker, {
          interruptAllowed: true,
          onSelect: controller.select,
          onDismiss: controller.dismiss,
        })
      : null,
  );
}

function renderHarness(onSend: (delivery: "interrupt" | "queue", draft: string) => void) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PickerHarness, { onSend }),
    ),
  );
}

function draftValue(): string {
  const textarea = document.querySelector('textarea[aria-label="draft"]');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("draft textarea missing");
  return textarea.value;
}

describe("composer interrupt picker keeps the draft", () => {
  it("Escape keeps the draft and sends nothing", () => {
    const onSend = vi.fn();
    renderHarness(onSend);

    fireEvent.click(screen.getByTestId("harness-send"));
    expect(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER)).toBeTruthy();
    expect(draftValue()).toBe("keep me");

    pressEscape();
    expect(queryByTestId(TID_COMPOSER_INTERRUPT_PICKER)).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(draftValue()).toBe("keep me");
  });

  it("click-away keeps the draft and sends nothing", () => {
    const onSend = vi.fn();
    renderHarness(onSend);

    fireEvent.click(screen.getByTestId("harness-send"));
    const textarea = document.querySelector('textarea[aria-label="draft"]')!;
    act(() => {
      textarea.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(queryByTestId(TID_COMPOSER_INTERRUPT_PICKER)).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(draftValue()).toBe("keep me");
  });

  it("interrupt option sends the current draft with the interrupt delivery", () => {
    const onSend = vi.fn();
    renderHarness(onSend);

    fireEvent.click(screen.getByTestId("harness-send"));
    fireEvent.click(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT));
    expect(onSend).toHaveBeenCalledWith("interrupt", "keep me");
  });

  it("queue option sends the current draft with the queue delivery", () => {
    const onSend = vi.fn();
    renderHarness(onSend);

    fireEvent.click(screen.getByTestId("harness-send"));
    fireEvent.click(screen.getByTestId(TID_COMPOSER_INTERRUPT_PICKER_QUEUE));
    expect(onSend).toHaveBeenCalledWith("queue", "keep me");
  });
});
