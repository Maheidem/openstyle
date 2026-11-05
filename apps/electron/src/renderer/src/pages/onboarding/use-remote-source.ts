import { getClient } from "@renderer/lib/api";
import { type AvailableModel, VOICE_META } from "@renderer/lib/models";
import { useCallback, useRef, useState } from "react";
import {
  kindFitsRole,
  type ModelRole,
  type ServerView,
} from "../models/server-roles";
import type { UseServers } from "../models/use-servers";

export type ServerTest =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; server: ServerView }
  | { state: "fail"; error: string };

export type KeyTest =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok" }
  // The provider said the key is not valid. The user must change it.
  | { state: "refused"; message: string }
  // The test could not reach the provider. The key is not proven wrong.
  | { state: "offline"; message: string };

export interface RemoteSource {
  serverUrl: string;
  serverKey: string;
  serverTest: ServerTest;
  /** The model that the user picked on the server. */
  serverModel: string | null;
  /** The models of the tested server that fit the role. */
  serverModels: string[];
  provider: string;
  cloudKey: string;
  keyTest: KeyTest;
  setServerUrl: (url: string) => void;
  setServerKey: (key: string) => void;
  testServer: () => Promise<void>;
  setServerModel: (model: string) => void;
  setProvider: (provider: string) => void;
  setCloudKey: (key: string) => void;
  testCloud: () => Promise<void>;
  /** Forget a test result (the user changed the source). */
  reset: () => void;
}

/**
 * The model that the first run gives to a provider. Voice: the cheapest model
 * that the provider does not plan to remove (the cost table of the Models page;
 * a model with no cost comes last). Text: the first model of the line-up of
 * the provider (the newest capable model), else the first curated model.
 */
export function cloudModelFor(
  available: readonly AvailableModel[],
  role: ModelRole,
  provider: string,
): AvailableModel | undefined {
  const own = available.filter(
    (m) => m.type === role && m.provider_id === provider,
  );
  if (role === "voice") {
    const current = own.filter((m) => !m.notice);
    const costOf = (m: AvailableModel): number =>
      VOICE_META[m.model_id]?.cost ?? Number.POSITIVE_INFINITY;
    return [...(current.length > 0 ? current : own)].sort(
      (a, b) => costOf(a) - costOf(b),
    )[0];
  }
  const rank = (m: AvailableModel): number =>
    m.lineup_rank ?? (m.curated ? 1000 : 2000);
  return [...own].sort((a, b) => rank(a) - rank(b))[0];
}

const NETWORK_ERROR = /could not reach|timed out/i;

/**
 * The state of the "My own server" and "Cloud provider" sources of one role.
 * It reuses the logic of the Models page: `useServers().addServer` probes the
 * address and saves a server that answers (`POST /api/servers`), and
 * `POST /api/keys/validate` checks a key without saving it. The model is saved
 * only when the user continues (`commit` in use-onboarding-models.ts).
 */
export function useRemoteSource(
  role: ModelRole,
  servers: UseServers,
  initial: { serverUrl?: string; provider?: string },
  defaultProvider: string,
): RemoteSource {
  const [serverUrl, setServerUrlState] = useState(initial.serverUrl ?? "");
  const [serverKey, setServerKey] = useState("");
  const [serverTest, setServerTest] = useState<ServerTest>({ state: "idle" });
  const [serverModel, setServerModel] = useState<string | null>(null);
  const [provider, setProviderState] = useState(
    initial.provider ?? defaultProvider,
  );
  const [cloudKey, setCloudKeyState] = useState("");
  const [keyTest, setKeyTest] = useState<KeyTest>({ state: "idle" });
  // A test that is still running must not write its result after the user
  // changed the field. Each change and each test makes a new number.
  const serverCall = useRef(0);
  const keyCall = useRef(0);

  const setServerUrl = useCallback((url: string) => {
    serverCall.current += 1;
    setServerUrlState(url);
    setServerTest({ state: "idle" });
    setServerModel(null);
  }, []);

  const testServer = useCallback(async () => {
    const call = ++serverCall.current;
    setServerTest({ state: "testing" });
    const result = await servers.addServer(serverUrl, serverKey);
    if (call !== serverCall.current) return;
    let view: ServerView | undefined;
    if (result.ok) {
      view = result.server;
    } else if (result.error === "duplicate" && result.existingId) {
      // The address is saved already. Read it again and use that server.
      const list = (await servers.refetch()) as { data?: ServerView[] };
      view = list.data?.find((s) => s.id === result.existingId);
      if (call !== serverCall.current) return;
    }
    if (!view) {
      setServerTest({
        state: "fail",
        error: result.ok ? "failed" : result.error,
      });
      return;
    }
    if (!view.reachable) {
      setServerTest({ state: "fail", error: view.error ?? "unreachable" });
      return;
    }
    const fitting = view.models.filter((m) => kindFitsRole(m.kind, role));
    setServerTest({ state: "ok", server: view });
    setServerModel(fitting[0]?.id ?? null);
  }, [role, serverKey, serverUrl, servers]);

  const setProvider = useCallback((next: string) => {
    keyCall.current += 1;
    setProviderState(next);
    setKeyTest({ state: "idle" });
  }, []);

  const setCloudKey = useCallback((key: string) => {
    keyCall.current += 1;
    setCloudKeyState(key);
    setKeyTest({ state: "idle" });
  }, []);

  const testCloud = useCallback(async () => {
    const key = cloudKey.trim();
    if (!key) return;
    const call = ++keyCall.current;
    setKeyTest({ state: "testing" });
    try {
      const res = await getClient().api.keys.validate.$post({
        json: { provider, key },
      });
      const body = (await res.json()) as { valid?: boolean; error?: string };
      if (call !== keyCall.current) return;
      if (body.valid) {
        setKeyTest({ state: "ok" });
      } else if (body.error && NETWORK_ERROR.test(body.error)) {
        setKeyTest({ state: "offline", message: body.error });
      } else {
        setKeyTest({
          state: "refused",
          message: body.error ?? "API key is not valid.",
        });
      }
    } catch {
      if (call !== keyCall.current) return;
      setKeyTest({ state: "offline", message: "Could not reach the app." });
    }
  }, [cloudKey, provider]);

  const reset = useCallback(() => {
    setServerTest({ state: "idle" });
    setKeyTest({ state: "idle" });
  }, []);

  const serverModels =
    serverTest.state === "ok"
      ? serverTest.server.models
          .filter((m) => kindFitsRole(m.kind, role))
          .map((m) => m.id)
      : [];

  return {
    serverUrl,
    serverKey,
    serverTest,
    serverModel,
    serverModels,
    provider,
    cloudKey,
    keyTest,
    setServerUrl,
    setServerKey,
    testServer,
    setServerModel,
    setProvider,
    setCloudKey,
    testCloud,
    reset,
  };
}
