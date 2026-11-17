import { useEffect, useRef } from "react";
import {
  TID_COMPOSER_INTERRUPT_PICKER,
  TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT,
  TID_COMPOSER_INTERRUPT_PICKER_STEER,
} from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerInterruptDelivery } from "@/v4/composer/composerInterruptPicker.js";

export interface ComposerInterruptPickerProps {
  /** False hides the interrupt option; the soft-steer option always remains. */
  interruptAllowed: boolean;
  onSelect: (delivery: ComposerInterruptDelivery) => void;
  /** Escape, click-away or a draft edit: close without sending or clearing the draft. */
  onDismiss: () => void;
}

const OPTION_CLASS_NAME =
  "flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-card-border hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focused";

/**
 * Inline two-option strip rendered above the composer input while a primary turn is
 * running. It is not a modal: the draft stays visible and editable, and dismissing it
 * never sends or clears anything.
 */
export function ComposerInterruptPicker({
  interruptAllowed,
  onSelect,
  onDismiss,
}: ComposerInterruptPickerProps) {
  const { intl } = useZCodeIntl();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Escape belongs to the picker while it is open: dismiss it and stop the event
    // before the pane-level Escape stop shortcut can preempt the running turn.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      onDismiss();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onDismiss]);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={intl.formatMessage({ id: "chat.composer.interruptPicker.title" })}
      data-testid={TID_COMPOSER_INTERRUPT_PICKER}
      className="relative z-10 mb-2 flex w-full flex-col gap-1 rounded-xl border border-card-border bg-card p-1.5 shadow-sm sm:flex-row"
    >
      {interruptAllowed ? (
        <button
          type="button"
          data-testid={TID_COMPOSER_INTERRUPT_PICKER_INTERRUPT}
          className={OPTION_CLASS_NAME}
          onClick={() => onSelect("interrupt")}
        >
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.composer.interruptPicker.interrupt" })}
          </span>
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.composer.interruptPicker.interruptDescription" })}
          </span>
        </button>
      ) : null}
      <button
        type="button"
        data-testid={TID_COMPOSER_INTERRUPT_PICKER_STEER}
        className={OPTION_CLASS_NAME}
        onClick={() => onSelect("guide")}
      >
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.composer.interruptPicker.steer" })}
        </span>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.composer.interruptPicker.steerDescription" })}
        </span>
      </button>
    </div>
  );
}
