import path from "node:path";

export const CONTROLLER_PROTOCOL_VERSION = 1 as const;
export const CONTROLLER_FRAME_BYTES = 64 * 1024;
export const CONTROLLER_MAX_ID_LENGTH = 128;
export const CONTROLLER_MAX_PATH_LENGTH = 4096;
export const CONTROLLER_MAX_PROFILE_LENGTH = 256;
export const CONTROLLER_MAX_CURSOR_LENGTH = 256;
export const CONTROLLER_MAX_REQUIREMENTS = 16;
export const CONTROLLER_MAX_SELECTOR_LENGTH = 132;

const CONTROLLER_ID_RE = /^[A-Za-z0-9_-]+$/;
const CONTROLLER_PROFILE_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROLLER_PROFILE_RE = new RegExp(
  `^(?:${CONTROLLER_PROFILE_TOKEN_RE.source.slice(1, -1)})(?:,(?:${CONTROLLER_PROFILE_TOKEN_RE.source.slice(1, -1)}))*$`,
);
const CONTROLLER_SELECTOR_RE = /^(?:runtime|app:[a-z0-9][a-z0-9-]*)$/;
function hasControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

type ControllerMethod = "handshake" | "observe" | "renew" | "release" | "status" | "watch";

export type ControllerHandshakeRequest = {
  version: 1;
  id: string;
  method: "handshake";
};

export type ControllerObserveRequest = {
  version: 1;
  id: string;
  method: "observe";
  path: string;
  session: string;
  profile: string;
  require: string[];
};

export type ControllerRenewRequest = {
  version: 1;
  id: string;
  method: "renew";
  session: string;
  store: string;
  epoch: number;
  generation: string;
};

export type ControllerReleaseRequest = {
  version: 1;
  id: string;
  method: "release";
  session: string;
  store: string;
  epoch: number;
  generation: string;
};

export type ControllerStatusRequest = {
  version: 1;
  id: string;
  method: "status";
  session?: string;
  cursor?: string;
};

export type ControllerWatchRequest = {
  version: 1;
  id: string;
  method: "watch";
  session: string;
  store: string;
  epoch: number;
  generation: string;
  after?: string;
  afterStore?: string;
  timeout: number;
};

export type ControllerRequest =
  | ControllerHandshakeRequest
  | ControllerObserveRequest
  | ControllerRenewRequest
  | ControllerReleaseRequest
  | ControllerStatusRequest
  | ControllerWatchRequest;

class ControllerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerProtocolError";
  }
}

function fail(message: string): never {
  throw new ControllerProtocolError(message);
}

function invalidRequest(): never {
  return fail("Invalid controller request.");
}

function assertFrameBound(input: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    invalidRequest();
  }
  if (encoded === undefined) invalidRequest();
  if (Buffer.byteLength(encoded, "utf8") > CONTROLLER_FRAME_BYTES) {
    fail("Controller request frame exceeds the maximum size.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    fail("Controller request contains unsupported fields.");
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    invalidRequest();
  }
}

function parseVersion(value: unknown): 1 {
  if (value !== CONTROLLER_PROTOCOL_VERSION) {
    fail("Unsupported controller protocol version.");
  }
  return CONTROLLER_PROTOCOL_VERSION;
}

function parseId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONTROLLER_MAX_ID_LENGTH ||
    !CONTROLLER_ID_RE.test(value)
  ) {
    invalidRequest();
  }
  return value;
}

function parsePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONTROLLER_MAX_PATH_LENGTH ||
    hasControlCharacter(value) ||
    !path.isAbsolute(value)
  ) {
    invalidRequest();
  }
  return value;
}

function parseProfile(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONTROLLER_MAX_PROFILE_LENGTH ||
    !CONTROLLER_PROFILE_RE.test(value)
  ) {
    invalidRequest();
  }
  return value;
}

function parseSelector(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONTROLLER_MAX_SELECTOR_LENGTH ||
    !CONTROLLER_SELECTOR_RE.test(value)
  ) {
    invalidRequest();
  }
  return value;
}

function parseRequirements(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CONTROLLER_MAX_REQUIREMENTS) {
    invalidRequest();
  }
  const requirements = value.map(parseSelector);
  if (new Set(requirements).size !== requirements.length) {
    invalidRequest();
  }
  return requirements;
}

function parseCursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONTROLLER_MAX_CURSOR_LENGTH ||
    hasControlCharacter(value)
  ) {
    invalidRequest();
  }
  return value;
}

function parseTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidRequest();
  }
  return value;
}

function parseEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidRequest();
  }
  return value;
}

function parseHeader<TMethod extends ControllerMethod>(
  value: Record<string, unknown>,
  method: TMethod,
  required: readonly string[],
  optional: readonly string[] = [],
): { version: 1; id: string; method: TMethod } {
  assertFields(value, ["version", "id", "method", ...required], optional);
  if (value.method !== method) {
    fail("Unsupported controller method.");
  }
  return {
    version: parseVersion(value.version),
    id: parseId(value.id),
    method,
  };
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  parser: (input: unknown) => string,
): string | undefined {
  if (!Object.hasOwn(value, field)) return undefined;
  return parser(value[field]);
}

export function parseControllerRequest(input: unknown): ControllerRequest {
  try {
    assertFrameBound(input);
    if (!isRecord(input) || typeof input.method !== "string") invalidRequest();

    switch (input.method) {
      case "handshake":
        return parseHeader(input, "handshake", []);
      case "observe": {
        const header = parseHeader(input, "observe", ["path", "session", "profile", "require"]);
        return {
          ...header,
          path: parsePath(input.path),
          session: parseId(input.session),
          profile: parseProfile(input.profile),
          require: parseRequirements(input.require),
        };
      }
      case "renew": {
        const header = parseHeader(input, "renew", ["session", "store", "epoch", "generation"]);
        return {
          ...header,
          session: parseId(input.session),
          store: parseId(input.store),
          epoch: parseEpoch(input.epoch),
          generation: parseId(input.generation),
        };
      }
      case "release": {
        const header = parseHeader(input, "release", ["session", "store", "epoch", "generation"]);
        return {
          ...header,
          session: parseId(input.session),
          store: parseId(input.store),
          epoch: parseEpoch(input.epoch),
          generation: parseId(input.generation),
        };
      }
      case "status": {
        const header = parseHeader(input, "status", [], ["session", "cursor"]);
        const session = optionalString(input, "session", parseId);
        const cursor = optionalString(input, "cursor", parseCursor);
        return {
          ...header,
          ...(session === undefined ? {} : { session }),
          ...(cursor === undefined ? {} : { cursor }),
        };
      }
      case "watch": {
        const header = parseHeader(
          input,
          "watch",
          ["session", "store", "epoch", "generation", "timeout"],
          ["after", "afterStore"],
        );
        const after = optionalString(input, "after", parseCursor);
        const afterStore = optionalString(input, "afterStore", parseId);
        return {
          ...header,
          session: parseId(input.session),
          store: parseId(input.store),
          epoch: parseEpoch(input.epoch),
          generation: parseId(input.generation),
          ...(after === undefined ? {} : { after }),
          ...(afterStore === undefined ? {} : { afterStore }),
          timeout: parseTimeout(input.timeout),
        };
      }
      default:
        fail("Unsupported controller method.");
    }
  } catch (error) {
    if (error instanceof ControllerProtocolError) throw error;
    throw new Error("Invalid controller request.");
  }
}
