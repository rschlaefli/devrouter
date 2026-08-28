import { describe, expect, it } from "vitest";
import {
  buildDesiredTLSCertificateHosts,
  compactTLSCertificateHosts,
  findUncoveredCertificateHosts,
  isHostCoveredByCertificateHost,
  parseDnsHostsFromSubjectAltName,
} from "../tls";

describe("parseDnsHostsFromSubjectAltName", () => {
  it("parses DNS SANs, normalizes case, and deduplicates", () => {
    const parsed = parseDnsHostsFromSubjectAltName(
      "DNS:localhost, DNS:*.localhost, DNS:Elearning.Klicker.Localhost, IP Address:127.0.0.1, DNS:localhost",
    );

    expect(parsed).toEqual(["*.localhost", "elearning.klicker.localhost", "localhost"]);
  });
});

describe("isHostCoveredByCertificateHost", () => {
  it("matches exact hosts", () => {
    expect(isHostCoveredByCertificateHost("demo.localhost", "demo.localhost")).toBe(true);
  });

  it("does not treat wildcard localhost as covering an explicit local hostname", () => {
    expect(isHostCoveredByCertificateHost("demo.localhost", "*.localhost")).toBe(false);
  });

  it("recognizes an exact wildcard SAN entry", () => {
    expect(isHostCoveredByCertificateHost("*.localhost", "*.localhost")).toBe(true);
  });

  it("matches single-label wildcard hosts for ordinary domains", () => {
    expect(isHostCoveredByCertificateHost("demo.example.test", "*.example.test")).toBe(true);
  });

  it("does not match multi-segment hosts with single-label wildcard", () => {
    expect(isHostCoveredByCertificateHost("elearning.klicker.localhost", "*.localhost")).toBe(
      false,
    );
  });
});

describe("findUncoveredCertificateHosts", () => {
  it("returns hosts not covered by cert DNS names", () => {
    const uncovered = findUncoveredCertificateHosts(
      ["localhost", "demo.localhost", "elearning.klicker.localhost"],
      ["localhost", "*.localhost"],
    );

    expect(uncovered).toEqual(["demo.localhost", "elearning.klicker.localhost"]);
  });
});

describe("buildDesiredTLSCertificateHosts", () => {
  it("keeps defaults and preserves existing and requested host coverage", () => {
    const hosts = buildDesiredTLSCertificateHosts(
      ["new.deep.localhost", "localhost"],
      ["existing.deep.localhost", "*.localhost"],
    );

    expect(hosts).toEqual(["*.deep.localhost", "*.localhost", "localhost"]);
    expect(
      findUncoveredCertificateHosts(
        ["existing.deep.localhost", "new.deep.localhost", "localhost"],
        hosts,
      ),
    ).toEqual([]);
  });

  it("compacts sibling workspace hosts without using the invalid localhost wildcard", () => {
    const hosts = buildDesiredTLSCertificateHosts(
      ["manage.klicker.worktree.localhost", "auth.klicker.worktree.localhost"],
      ["api.klicker.worktree.localhost", "demo.localhost"],
    );

    expect(hosts).toEqual([
      "*.klicker.worktree.localhost",
      "*.localhost",
      "demo.localhost",
      "localhost",
    ]);
  });
});

describe("compactTLSCertificateHosts", () => {
  it("preserves coverage while removing exact SANs already covered by a wildcard", () => {
    const sourceHosts = [
      "*.localhost",
      "api.klicker.alpha.localhost",
      "auth.klicker.alpha.localhost",
      "manage.klicker.alpha.localhost",
      "single.localhost",
    ];
    const compacted = compactTLSCertificateHosts(sourceHosts);

    expect(compacted).toEqual(["*.klicker.alpha.localhost", "*.localhost", "single.localhost"]);
    expect(findUncoveredCertificateHosts(sourceHosts, compacted)).toEqual([]);
  });
});
