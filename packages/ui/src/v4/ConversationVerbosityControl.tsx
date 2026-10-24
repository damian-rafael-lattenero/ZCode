import { useCallback } from "react";
import { ListFilterIcon } from "lucide-react";
import type { MessageStreamVerbosity } from "@zcode/shared";
import {
  TID_V4_VERBOSITY_CONTROL,
  TID_V4_VERBOSITY_EXPAND_TOGGLE,
  TID_V4_VERBOSITY_OPTION,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { useSettings } from "@/hooks/useSettingService.js";

const VERBOSITY_MODES: readonly MessageStreamVerbosity[] = ["summary", "normal", "verbose"];

/**
 * 消息流详略档位入口（spec：docs/specs/conversation-verbosity-views.md）。
 *
 * 自足组件：直接读写 user-scope shared settings（与 SettingsPage 同一条
 * settingService 路径），不进 composer 的 submission 配置状态机——档位是
 * 视图偏好，与「下一次提交用什么模型」无关。切换后 SessionPane 的
 * rowContext / conversationExpandDefaultStore 同步生效，历史轮回溯重渲染。
 */
export function ConversationVerbosityControl({ compact = false }: { compact?: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const verbosity = settings?.messageStreamVerbosity ?? "normal";
  const expandedByDefault = settings?.messageStreamExpandedByDefault ?? false;

  const handleVerbosityChange = useCallback(
    async (mode: MessageStreamVerbosity) => {
      if (mode === verbosity) return;
      await runUserActionAsync({
        input: { featureId: "conversation.view", action: "change_verbosity", trigger: "menu" },
        operation: () => update({ messageStreamVerbosity: mode }),
        completed: { resultSource: "shared_settings", valueAfter: mode },
        failureStage: "verbosity_change",
      });
    },
    [update, verbosity],
  );

  const handleExpandedByDefaultChange = useCallback(
    async (enabled: boolean) => {
      if (enabled === expandedByDefault) return;
      await runUserActionAsync({
        input: {
          featureId: "conversation.view",
          action: "toggle_expand_by_default",
          trigger: "menu",
        },
        operation: () => update({ messageStreamExpandedByDefault: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
        failureStage: "expand_by_default_change",
      });
    },
    [expandedByDefault, update],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-ui-sm text-foreground-subtle"
          data-testid={TID_V4_VERBOSITY_CONTROL}
          data-verbosity={verbosity}
          title={intl.formatMessage({ id: "chat.verbosity.title" })}
          aria-label={intl.formatMessage({ id: "chat.verbosity.title" })}
        >
          <ListFilterIcon className="size-4 shrink-0" aria-hidden />
          {!compact ? (
            <span className="whitespace-nowrap">
              {intl.formatMessage({ id: `chat.verbosity.${verbosity}` })}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup
          value={verbosity}
          onValueChange={(value) => {
            void handleVerbosityChange(value as MessageStreamVerbosity);
          }}
        >
          {VERBOSITY_MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              data-testid={testId(TID_V4_VERBOSITY_OPTION, mode)}
            >
              <div className="flex min-w-0 flex-col">
                <span>{intl.formatMessage({ id: `chat.verbosity.${mode}` })}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: `chat.verbosity.${mode}Description` })}
                </span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={expandedByDefault}
          onCheckedChange={(checked) => {
            void handleExpandedByDefaultChange(checked === true);
          }}
          data-testid={TID_V4_VERBOSITY_EXPAND_TOGGLE}
        >
          <div className="flex min-w-0 flex-col">
            <span>{intl.formatMessage({ id: "chat.verbosity.expandByDefault" })}</span>
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.verbosity.expandByDefaultDescription" })}
            </span>
          </div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
