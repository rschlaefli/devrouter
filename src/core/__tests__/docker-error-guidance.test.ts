import { describe, expect, it } from "vitest";
import { withDockerFailureGuidance } from "../docker-error-guidance";

describe("withDockerFailureGuidance", () => {
  it("returns unchanged details when disk-space condition is absent", () => {
    const details = "pull access denied for image";
    expect(withDockerFailureGuidance(details)).toBe(details);
  });

  it("adds non-destructive disk-space guidance for no-space errors", () => {
    const message = withDockerFailureGuidance("write /var/lib/docker: no space left on device");

    expect(message).toContain("Docker storage appears full");
    expect(message).toContain("Free Docker disk space using your preferred method");
    expect(message.toLowerCase()).not.toContain("prune");
  });
});
