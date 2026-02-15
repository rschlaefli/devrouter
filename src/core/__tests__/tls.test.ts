import { describe, expect, it } from "vitest";
import {
  buildDesiredTLSCertificateHosts,
  findUncoveredCertificateHosts,
  isHostCoveredByCertificateHost,
  parseDnsHostsFromSubjectAltName
} from "../tls";

describe("parseDnsHostsFromSubjectAltName", () => {
  it("parses DNS SANs, normalizes case, and deduplicates", () => {
    const parsed = parseDnsHostsFromSubjectAltName(
      "DNS:localhost, DNS:*.localhost, DNS:Elearning.Klicker.Localhost, IP Address:127.0.0.1, DNS:localhost"
    );

    expect(parsed).toEqual(["*.localhost", "elearning.klicker.localhost", "localhost"]);
  });
});

describe("isHostCoveredByCertificateHost", () => {
  it("matches exact hosts", () => {
    expect(isHostCoveredByCertificateHost("demo.localhost", "demo.localhost")).toBe(true);
  });

  it("matches single-label wildcard hosts", () => {
    expect(isHostCoveredByCertificateHost("demo.localhost", "*.localhost")).toBe(true);
  });

  it("does not match multi-segment hosts with single-label wildcard", () => {
    expect(isHostCoveredByCertificateHost("elearning.klicker.localhost", "*.localhost")).toBe(false);
  });
});

describe("findUncoveredCertificateHosts", () => {
  it("returns hosts not covered by cert DNS names", () => {
    const uncovered = findUncoveredCertificateHosts(
      ["localhost", "demo.localhost", "elearning.klicker.localhost"],
      ["localhost", "*.localhost"]
    );

    expect(uncovered).toEqual(["elearning.klicker.localhost"]);
  });
});

describe("buildDesiredTLSCertificateHosts", () => {
  it("keeps defaults, preserves existing explicit SANs, and adds requested hosts", () => {
    const hosts = buildDesiredTLSCertificateHosts(
      ["new.deep.localhost", "localhost"],
      ["existing.deep.localhost", "*.localhost"]
    );

    expect(hosts).toEqual([
      "*.localhost",
      "existing.deep.localhost",
      "localhost",
      "new.deep.localhost"
    ]);
  });
});
