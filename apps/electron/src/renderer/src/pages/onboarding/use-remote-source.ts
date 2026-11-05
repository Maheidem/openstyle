import { getClient } from "@renderer/lib/api";
import type { AvailableModel } from "@renderer/lib/models";
import { useCallback, useState } from "react";
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

/** The first cloud model of a provider for a role, in the order of the catalog. */
export function cloudModelFor(
  available: readonly AvailableModel[],
  role: ModelRole,
  provider: string,
): AvailableModel | undefined {
  return available.find((m) => m.type === role && m.provider_id === provider);
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

  const setServerUrl = useCallback((url: string) => {
    setServerUrlState(url);
    setServerTest({ state: "idle" });
    setServerModel(null);
  }, []);

  const testServer = useCallback(async () => {
    setServerTest({ state: "testing" });
    const result = await servers.addServer(serverUrl, serverKey);
    let view: ServerView | undefined;
    if (result.ok) {
      view = result.server;
    } else if (result.error === "duplicate" && result.existingId) {
      // The address is saved already. Read it again and use that server.
      const list = (await servers.refetch()) as { data?: ServerView[] };
      view = list.data?.find((s) => s.id === result.existingId);
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
    setProviderState(next);
    setKeyTest({ state: "idle" });
  }, []);

  const setCloudKey = useCallback((key: string) => {
    setCloudKeyState(key);
    setKeyTest({ state: "idle" });
  }, []);

  const testCloud = useCallback(async () => {
    const key = cloudKey.trim();
    if (!key) return;
    setKeyTest({ state: "testing" });
    try {
      const res = await getClient().api.keys.validate.$post({
        json: { provider, key },
      });
      const body = (await res.json()) as { valid?: boolean; error?: string };
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
