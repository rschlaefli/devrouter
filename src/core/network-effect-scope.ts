import { AsyncLocalStorage } from "node:async_hooks";

const guards = new AsyncLocalStorage<{
  guard: () => void;
  active: boolean;
  endpoint?: string | (() => string | undefined);
}>();

/** Scope evidence checks to the current ensure, including its asynchronous effects. */
export function withNetworkEffectGuard<T>(
  guard: () => void,
  operation: () => T,
  endpoint?: string | (() => string | undefined),
): T {
  const scope = { guard, endpoint, active: true };
  return guards.run(scope, () => {
    try {
      const result = operation();
      if (result instanceof Promise)
        return result.finally(() => {
          scope.active = false;
        }) as T;
      scope.active = false;
      return result;
    } catch (error) {
      scope.active = false;
      throw error;
    }
  });
}

export function assertNetworkEffectAllowed(): void {
  const scope = guards.getStore();
  if (scope && !scope.active)
    throw new Error("Network operation scope has ended; delayed effects are blocked.");
  scope?.guard();
}

export function networkDockerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const endpoint = networkDockerEndpoint();
  if (!endpoint) return source;
  const env: NodeJS.ProcessEnv = { ...source, DOCKER_HOST: endpoint };
  delete env.DOCKER_CONTEXT;
  return env;
}

export function networkDockerEndpoint(): string | undefined {
  const scope = guards.getStore();
  if (scope && !scope.active)
    throw new Error("Network operation scope has ended; child dispatch is blocked.");
  const value = scope?.endpoint;
  return typeof value === "function" ? value() : value;
}

export function networkDockerOptions(): { env?: NodeJS.ProcessEnv } {
  return networkDockerEndpoint() ? { env: networkDockerEnvironment() } : {};
}
