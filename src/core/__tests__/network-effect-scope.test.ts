import { describe, expect, it, vi } from "vitest";
import {
  assertNetworkEffectAllowed,
  networkDockerEndpoint,
  networkDockerEnvironment,
  withNetworkEffectGuard,
} from "../network-effect-scope";

describe("network effect guard scope", () => {
  it("pins child environments without modifying ambient selectors", async () => {
    const source = {
      DOCKER_CONTEXT: "foreign",
      DOCKER_HOST: "unix:///foreign.sock",
      WORKSPACE: "synthetic",
    };
    await withNetworkEffectGuard(
      () => {},
      async () => {
        await Promise.resolve();
        expect(networkDockerEnvironment(source)).toEqual({
          DOCKER_HOST: "unix:///owned.sock",
          WORKSPACE: "synthetic",
        });
        expect(source.DOCKER_CONTEXT).toBe("foreign");
      },
      "unix:///owned.sock",
    );
    expect(networkDockerEndpoint()).toBeUndefined();
    expect(networkDockerEnvironment(source)).toBe(source);
  });
  it("isolates concurrent effects and restores scope after success and failure", async () => {
    const left = vi.fn();
    const right = vi.fn();
    await Promise.all([
      withNetworkEffectGuard(left, async () => {
        await Promise.resolve();
        assertNetworkEffectAllowed();
      }),
      withNetworkEffectGuard(right, async () => {
        await Promise.resolve();
        assertNetworkEffectAllowed();
      }),
    ]);
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
    await expect(
      withNetworkEffectGuard(
        () => {
          throw new Error("blocked");
        },
        async () => {
          await Promise.resolve();
          assertNetworkEffectAllowed();
        },
      ),
    ).rejects.toThrow("blocked");
    expect(assertNetworkEffectAllowed).not.toThrow();
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
  });
});

it("rejects a detached continuation after its ensure scope has ended", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed!: Promise<boolean>;
  await withNetworkEffectGuard(
    () => {},
    async () => {
      delayed = pending.then(() => {
        try {
          assertNetworkEffectAllowed();
          return false;
        } catch {
          return true;
        }
      });
    },
    "unix:///synthetic.sock",
  );
  release();
  expect(await delayed).toBe(true);
  expect(networkDockerEndpoint()).toBeUndefined();
});
