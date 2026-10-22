import {
  availableModelsQueryOptions,
  configuredModelsQueryOptions,
} from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Model id to model name, for the history labels. The available list has
 * only the built-in models that are on disk, so the configured models (which
 * keep the name the picker saved) fill the gaps.
 */
export function useModelNames(): ReadonlyMap<string, string> {
  const { data: available } = useQuery(availableModelsQueryOptions());
  const { data: configured } = useQuery(configuredModelsQueryOptions());
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const m of configured ?? []) names.set(m.model_id, m.model_name);
    for (const m of available ?? []) names.set(m.model_id, m.model_name);
    return names;
  }, [available, configured]);
}
