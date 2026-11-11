import type { MetadataEntryProto } from "types/api_types";
import type { Tree } from "viewer/model/types/tree_types";
import {
  getTreeIdentity,
  hasIdentityMetadata,
  withMergedCandidates,
} from "viewer/view/right_border_tabs/neuron_identity_tab/neuron_identity_metadata";
import { describe, expect, it } from "vitest";

function treeWith(metadata: MetadataEntryProto[]): Tree {
  return { metadata } as unknown as Tree;
}

describe("identity display names", () => {
  it("stores a candidate's display name and reads it back", () => {
    const metadata = withMergedCandidates(
      [],
      "prediction:nuclear:embryo1:100",
      [
        { name: "ABalaaaalal", display_name: "AINL", score: 0.8 },
        { name: "ABal", display_name: null, score: 0.2 },
      ],
      1,
    );

    const identity = getTreeIdentity(treeWith(metadata));
    expect(identity.displayNames).toEqual({ ABalaaaalal: "AINL" });
    expect(identity.candidates.map((candidate) => candidate.name)).toEqual(["ABalaaaalal", "ABal"]);
    expect(hasIdentityMetadata(treeWith(metadata))).toBe(true);
  });

  it("keeps candidates as [name, score] tuples so older builds still read them", () => {
    const metadata = withMergedCandidates(
      [],
      "prediction:nuclear:embryo1:100",
      [{ name: "ABalaaaalal", display_name: "AINL", score: 0.8 }],
      1,
    );

    const sourceEntry = metadata.find(
      (entry) => entry.key === "identity.source.prediction:nuclear:embryo1:100",
    );
    expect(JSON.parse(sourceEntry?.stringValue ?? "")).toEqual([["ABalaaaalal", 0.8]]);
  });

  it("merges display names from several sources on the same tree", () => {
    let metadata = withMergedCandidates(
      [],
      "prediction:nuclear:embryo1:100",
      [{ name: "ABalaaaalal", display_name: "AINL", score: 0.8 }],
      1,
    );
    metadata = withMergedCandidates(
      metadata,
      "prediction:nuclear:embryo2:100",
      [{ name: "ABalaaaarlp", display_name: "RMEL", score: 0.6 }],
      2,
    );

    expect(getTreeIdentity(treeWith(metadata)).displayNames).toEqual({
      ABalaaaalal: "AINL",
      ABalaaaarlp: "RMEL",
    });
  });

  it("leaves the display-name entry alone when a source has none", () => {
    let metadata = withMergedCandidates(
      [],
      "prediction:nuclear:embryo1:100",
      [{ name: "ABalaaaalal", display_name: "AINL", score: 0.8 }],
      1,
    );
    metadata = withMergedCandidates(metadata, "offline_csv", [{ name: "ADAL", score: 0.9 }], 2);

    expect(getTreeIdentity(treeWith(metadata)).displayNames).toEqual({ ABalaaaalal: "AINL" });
  });

  it("reads metadata written before display names existed", () => {
    const metadata: MetadataEntryProto[] = [
      { key: "identity.source.prediction:witvliet", stringValue: '[["ADAL",0.9]]' },
    ];

    const identity = getTreeIdentity(treeWith(metadata));
    expect(identity.displayNames).toEqual({});
    expect(identity.candidates).toEqual([
      { name: "ADAL", scoresBySource: { "prediction:witvliet": 0.9 } },
    ]);
  });

  it("ignores a malformed display-name entry", () => {
    const metadata: MetadataEntryProto[] = [
      { key: "identity.displayNames", stringValue: "not json" },
    ];

    expect(getTreeIdentity(treeWith(metadata)).displayNames).toEqual({});
  });
});
