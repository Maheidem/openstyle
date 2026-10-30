import type {
  OverviewActionItem,
  OverviewSource,
} from "@openstyle/validations";

// The pure parts of the folder Overview (issue #374,
// specs/folder-project-page.md 3).

/** Sources that the list shows before the "+N" counter. */
export const SOURCES_SHOWN = 2;

/** The open items first, then the done items. The server order stays. */
export function splitActionItems(items: readonly OverviewActionItem[]): {
  open: OverviewActionItem[];
  done: OverviewActionItem[];
} {
  return {
    open: items.filter((i) => !i.done),
    done: items.filter((i) => i.done),
  };
}

/** The sources to show, and how many are hidden. */
export function visibleSources(
  sources: readonly OverviewSource[],
  expanded: boolean,
): { shown: OverviewSource[]; hidden: number } {
  const limit = expanded ? sources.length : SOURCES_SHOWN;
  return {
    shown: sources.slice(0, limit),
    hidden: Math.max(0, sources.length - limit),
  };
}
