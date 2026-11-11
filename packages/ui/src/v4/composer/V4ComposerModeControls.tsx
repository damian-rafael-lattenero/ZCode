import { modeTriggerColor } from "@/chat-input-toolbar/display-help.js";
import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, ChevronDownIcon } from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskModeInfo,
} from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useYoloModeConfirmation } from "@/hooks/useConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/**
 * The permission radio menu (build/yolo/guarded). It only mounts once a mode
 * is selected, so an undefined↔defined `selected` flip is a legal fiber
 * mount/unmount — never a hooks-count change on a live fiber (the React
 * #301 class). Its own hooks run unconditionally.
 */
function V4ComposerPermissionMenu({
  selected,
  permissions,
  displayProvider,
  disabled,
  modeShortcutLabel,
  activeConfigPicker,
  onConfigPickerOpenChange,
  requestSwitchMode,
}: {
  selected: ZCodeTaskModeInfo;
  permissions: ZCodeTaskModeInfo[];
  displayProvider: ZCodeProvider;
  disabled?: boolean;
  modeShortcutLabel: string;
  activeConfigPicker: V4ComposerToolbarProps["activeConfigPicker"];
  onConfigPickerOpenChange: V4ComposerToolbarProps["onConfigPickerOpenChange"];
  requestSwitchMode: (mode: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = (mode: (typeof permissions)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <DropdownMenu
      open={activeConfigPicker === "mode"}
      onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
        shortcut={modeShortcutLabel}
        open={activeConfigPicker === "mode" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
            data-composer-collapse-priority="1"
            aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
            className={cn(
              "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              modeTriggerColor(selected.id),
            )}
          >
            <Icon className="size-4" />
            <span className="inline group-data-[composer-compact=true]/mode:hidden">
              {/* Plan 菜单重写时普通 span 丢失了旧 ConfigSelect 的翻滚；复用同一动画组件恢复。 */}
              <RollingToolbarLabel label={label(selected)} />
            </span>
            <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!useConfirmDialogStore.getState().pendingRequest && !isCoarseTouchDevice())
            document
              .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
              ?.focus();
        }}
      >
        <DropdownMenuRadioGroup value={selected.id} onValueChange={requestSwitchMode}>
          {permissions.map((mode) => {
            const ModeIcon = resolveModeOptionIcon(mode.id);
            const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
              value: mode.id,
            });
            return (
              <DropdownMenuRadioItem
                key={mode.id}
                value={mode.id}
                data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                className="min-h-13 items-start gap-3 py-2"
              >
                <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{label(mode)}</span>
                  {descriptionId && (
                    <span className="text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: descriptionId })}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The composer's mode controls: a STANDALONE plan toggle (the owner's law,
 * 10/11 — outside the permission menu, always speaking its state) plus the
 * permission radio menu (build/yolo/guarded). Draft-only: neither writes to
 * the runtime until the next submission carries the config.
 *
 * Hooks law: EVERY hook runs unconditionally before any conditional render —
 * the old `if (!selected) return null` after the hook block was the React
 * #301 class, and it also blacked out the whole control cluster while a live
 * session's first config snapshot was still pending. The toggle now always
 * speaks; only the permission menu waits for a selected mode.
 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl } = useZCodeIntl();
  // 原草稿回调随 scope 换代，旧确认不能把权限写入后来选中的任务。
  const confirmMode = useYoloModeConfirmation(disabled ? null : onSwitchMode, draftConfig?.mode);
  const requestSwitchMode = useCallback(
    (mode: string) => {
      confirmMode(mode, () => onSwitchMode(mode));
    },
    [confirmMode, onSwitchMode],
  );
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  const permissions = modes.filter((mode) => mode.id !== "plan");
  // 新菜单隐藏 Edit，但历史草稿仍可回显，不能因候选变化隐藏整个权限入口。
  const selected =
    permissions.find((mode) => mode.id === draftConfig?.mode) ??
    (draftConfig?.mode === "edit" ? { id: "edit", name: "Edit" } : undefined);
  // THE OWNER'S LAW (10/11): plan lives OUTSIDE the permission menu — a
  // standalone on/off toggle that always speaks its state, never a buried
  // checkbox. The label stays fixed; the STATE is the color + strike
  // (green/plain = active, red/struck = inactive — the owner's own design).
  // The permission menu stays a pure radio group.
  const planEnabled = draftConfig?.planEnabled ?? false;
  const planLabel = intl.formatMessage({ id: "chat.toolbar.planToggle.label" });
  const planStateLabel = intl.formatMessage({
    id: planEnabled ? "chat.toolbar.planToggle.on" : "chat.toolbar.planToggle.off",
  });
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: draftConfig?.mode ?? "build",
      options: getZCodeAgentAvailableModes()
        .filter((mode) => mode.id !== "plan")
        .map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [draftConfig?.mode],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) requestSwitchMode(next);
  }, [modeOption, requestSwitchMode]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        data-testid="v4-composer-plan-toggle"
        data-composer-collapse-priority="2"
        aria-pressed={planEnabled}
        aria-label={planStateLabel}
        onClick={() => onSwitchMode(planEnabled ? "plan-off" : "plan")}
        className={cn(
          "group/plan h-7 gap-1 rounded-lg px-2 text-ui-base",
          planEnabled
            ? "text-success hover:text-success"
            : "text-destructive hover:text-destructive",
        )}
      >
        <LightbulbIcon className="size-4" />
        <span
          className={cn(
            "inline group-data-[composer-compact=true]/plan:hidden",
            !planEnabled && "line-through",
          )}
        >
          {planLabel}
        </span>
      </Button>
      {selected && (
        <V4ComposerPermissionMenu
          selected={selected}
          permissions={permissions}
          displayProvider={displayProvider}
          disabled={disabled}
          modeShortcutLabel={modeShortcutLabel}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={onConfigPickerOpenChange}
          requestSwitchMode={requestSwitchMode}
        />
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
