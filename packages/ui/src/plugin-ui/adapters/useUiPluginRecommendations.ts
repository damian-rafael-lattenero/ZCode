import { useEffect, useState } from "react";
import type { ClientConfigSnapshot } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/*
 * FORK CHANGE (damian-rafael-lattenero / ZCode fork): local UI-plugin recommendations.
 * Upstream serves `uiPluginRecommendations` from the Z.ai client-config service, so
 * personally-installed plugins never surface in the side-pane "New tab" App plugins grid.
 * This fork prepends the entries below to whatever the server returns; entries whose
 * pluginId is absent from the local store catalog are dropped by the join in
 * useRecommendedUiPlugins, so removing the marketplace degrades gracefully.
 * pluginId format: "<name>@<marketplace>".
 */
const FORK_DIFF_ASK_PLUGIN_ID = "diff-ask@dev-zcode-diff-ask-5098ef5a";
const FORK_DIFF_ASK_SURFACE_ID = "diff-ask";
export { FORK_DIFF_ASK_PLUGIN_ID, FORK_DIFF_ASK_SURFACE_ID };

const FORK_UI_PLUGIN_RECOMMENDATIONS: ClientConfigSnapshot["uiPluginRecommendations"] = [
  { pluginId: FORK_DIFF_ASK_PLUGIN_ID, surfaceId: FORK_DIFF_ASK_SURFACE_ID },
];

function withForkRecommendations(list: ClientConfigSnapshot["uiPluginRecommendations"]) {
  const seen = new Set(list.map((entry) => `${entry.pluginId}/${entry.surfaceId}`));
  return [
    ...FORK_UI_PLUGIN_RECOMMENDATIONS.filter(
      (entry) => !seen.has(`${entry.pluginId}/${entry.surfaceId}`),
    ),
    ...list,
  ];
}

/** 缓存和请求合并归 Host 配置服务；此处只持有当前入口的展示投影。 */
export function useUiPluginRecommendations(enabled: boolean) {
  const service = useOptionalServices()?.clientConfigService;
  const [snapshot, setSnapshot] = useState<{
    service: typeof service;
    recommendations: ClientConfigSnapshot["uiPluginRecommendations"];
  }>();
  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    if (enabled && service) {
      void service.getSnapshot().then(
        ({ uiPluginRecommendations }) => {
          if (active)
            setSnapshot({
              service,
              recommendations: withForkRecommendations(uiPluginRecommendations ?? []),
            });
        },
        () => {
          if (active) {
            setSnapshot({ service, recommendations: [] });
            logger.warn("[plugin-ui] 推荐配置读取失败");
          }
        },
      );
    }
    // 服务切换或入口关闭后，旧请求不能重新发布推荐。
    return () => {
      active = false;
    };
  }, [enabled, service]);
  const current = enabled && snapshot?.service === service ? snapshot : undefined;
  // 空数组不能区分尚未返回与确认无推荐，避免冷启动先闪空态。
  return {
    recommendations: current?.recommendations ?? [],
    loading: enabled && Boolean(service) && !current,
  };
}
