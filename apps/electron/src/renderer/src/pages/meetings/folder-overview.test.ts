import type { FolderOverview } from "@openstyle/validations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/query";
import en from "../../locales/en.json";
import { FolderOverviewView } from "./folder-overview";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }),
}));

const source = (id: string, title: string) => ({
  meeting_id: id,
  title,
  started_at: 1_700_000_000_000,
});

const base: FolderOverview = {
  folder: { id: "f1", name: "Harbor", description: null, color: null },
  counts: {
    meetings: 2,
    summarized: 2,
    total_duration_ms: 120000,
    first_meeting_at: 1,
    last_meeting_at: 2,
    stage_counts: {
      transcribe: { ready: 0, blocked: 0 },
      summarize: { ready: 0, blocked: 0 },
      enhance: { ready: 0, blocked: 0 },
    },
  },
  timeline: [
    {
      meeting_id: "m2",
      title: "Beta plan",
      started_at: 2,
      duration_ms: 60000,
      gist: "We plan the beta.",
    },
    {
      meeting_id: "m1",
      title: "Kickoff",
      started_at: 1,
      duration_ms: 60000,
      gist: null,
    },
  ],
  decisions: [
    {
      text: "Use React Native",
      sources: [source("m1", "Kickoff"), source("m2", "Beta plan")],
    },
  ],
  action_items: [
    {
      key: "aaaaaaaaaaaaaaaa",
      text: "Send the pricing sheet",
      owner: "Ana",
      due: "Friday",
      done: false,
      sources: [source("m1", "Kickoff")],
    },
    {
      key: "bbbbbbbbbbbbbbbb",
      text: "Book the demo room",
      owner: null,
      due: null,
      done: true,
      sources: [source("m2", "Beta plan")],
    },
  ],
  open_questions: [],
  people: [{ name: "Ana Reyes", meeting_count: 2 }],
  tags: [],
  last_activity: 2,
};

function render(overview: FolderOverview) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.meetings.folderOverview("f1"), overview);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FolderOverviewView, { folderId: "f1", onOpen: vi.fn() }),
    ),
  );
}

describe("folder overview view", () => {
  it("lists open items with owner, due and source, and hides done items", () => {
    const html = render(base);
    expect(html).toContain("Send the pricing sheet");
    expect(html).toContain("Owner: Ana");
    expect(html).toContain("Due: Friday");
    expect(html).not.toContain("Book the demo room");
    expect(html).toContain("Show done (1)");
    expect(html).toContain("Use React Native");
    expect(html).toContain("We plan the beta.");
    expect(html).toContain("No summary yet");
    expect(html).toContain("Ana Reyes");
  });

  it("shows empty states", () => {
    const html = render({
      ...base,
      counts: { ...base.counts, meetings: 1, summarized: 0 },
      timeline: [],
      decisions: [],
      action_items: [],
      people: [],
      last_activity: null,
    });
    expect(html).toContain("No action items in the summaries");
    expect(html).toContain("No decisions in the summaries");
    expect(html).toContain("This folder has no meetings.");
    expect(html).toContain("No names found");
    expect(html).toContain("No tags on the meetings");
    expect(html).toContain("has a summary yet");
  });

  it("says that all items are done", () => {
    const html = render({
      ...base,
      action_items: (base.action_items ?? []).map((a) => ({
        ...a,
        done: true,
      })),
    });
    expect(html).toContain("All action items are done.");
  });
});
