import { useCallback, useRef, useState } from "react";
import type {
  ActionAvailability,
  ActiveWorkSummary,
  InputRouting,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Busy-composer delivery choice: cut the current model step and continue the same
 * turn, or queue the prompt until the turn ends.
 */
export type ComposerInterruptDelivery = "interrupt" | "queue";

export interface ComposerInterruptPickerGate {
  /**
   * The submission already passed the composer guard: text/attachments are sendable,
   * no upload or voice settle is pending, and the target scope is stable.
   */
  canSend: boolean;
  /** The projection exposes a stop target, i.e. a foreground turn exists. */
  canStop: boolean;
  /** Active works from the same snapshot; a background-only session does not qualify. */
  activeWorks: readonly Pick<ActiveWorkSummary, "kind">[];
  /** mode=choice has its own paused-queue confirmation dialog, never this picker. */
  inputRoutingMode: InputRouting["mode"];
  /** The paused-queue confirmation dialog owns the decision while it is open. */
  heldQueueConfirmationOpen: boolean;
  /** Cmd/Ctrl+Enter or a confirmed delivery choice already decided for this submit. */
  explicitDeliveryOverride: boolean;
}

export function isPrimaryTurnActive(
  activeWorks: readonly Pick<ActiveWorkSummary, "kind">[],
): boolean {
  return activeWorks.some((work) => work.kind === "primaryTurn");
}

/**
 * Whether a submit must open the interrupt/queue picker instead of sending.
 * Everything except the foreground-turn proof comes from the same submit guard,
 * so the decision never stacks two conflicting busy-input flows.
 */
export function shouldOfferComposerInterruptPicker(gate: ComposerInterruptPickerGate): boolean {
  return (
    gate.canSend &&
    gate.canStop &&
    isPrimaryTurnActive(gate.activeWorks) &&
    gate.inputRoutingMode !== "choice" &&
    !gate.heldQueueConfirmationOpen &&
    !gate.explicitDeliveryOverride
  );
}

/**
 * Whether the projection allows the interrupt option. Old CLI frames lack the field;
 * in that case keep the option visible and let admission reject it (the queue option
 * remains a safe fallback).
 */
export function isInterruptSteerOffered(availability: ActionAvailability | undefined): boolean {
  return availability?.allowed !== false;
}

export interface ComposerInterruptPickerController {
  open: boolean;
  /**
   * Returns true when the submit must stop and show the picker; false when the caller
   * may continue with the normal send path.
   */
  request: (gate: ComposerInterruptPickerGate) => boolean;
  /** Confirms an option and forwards the chosen delivery to the owner. */
  select: (delivery: ComposerInterruptDelivery) => void;
  /** Escape / click-away / draft edit: close without touching the draft. */
  dismiss: () => void;
}

/**
 * Owns the inline picker state for the composer. Delivery is forwarded raw so the
 * composer can pass it as `requestedDelivery` to sendText.
 */
export function useComposerInterruptPickerController(options: {
  onDeliver: (delivery: ComposerInterruptDelivery) => void;
}): ComposerInterruptPickerController {
  const [open, setOpen] = useState(false);
  const onDeliverRef = useRef(options.onDeliver);
  onDeliverRef.current = options.onDeliver;

  const request = useCallback((gate: ComposerInterruptPickerGate) => {
    if (!shouldOfferComposerInterruptPicker(gate)) return false;
    setOpen(true);
    return true;
  }, []);

  const select = useCallback((delivery: ComposerInterruptDelivery) => {
    setOpen(false);
    onDeliverRef.current(delivery);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  return { open, request, select, dismiss };
}
