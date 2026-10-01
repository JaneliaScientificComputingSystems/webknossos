import {
  AimOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  CheckOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import {
  AutoComplete,
  Button,
  Checkbox,
  Empty,
  type MenuProps,
  Select,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { V4 } from "libs/mjs";
import { useWkSelector } from "libs/react_hooks";
import Toast from "libs/toast";
import { type MouseEvent, useMemo, useState } from "react";
import { useDispatch } from "react-redux";
import type { Vector4 } from "viewer/constants";
import { mayEditAnnotation } from "viewer/model/accessors/annotation_accessor";
import { getVisibleSegmentationLayer } from "viewer/model/accessors/dataset_accessor";
import { layerToGlobalTransformedPosition } from "viewer/model/accessors/dataset_layer_transformation_accessor";
import {
  getSegmentColorAsRGBA,
  getSelectedIds,
  getVisibleSegments,
} from "viewer/model/accessors/volumetracing_accessor";
import {
  setAdditionalCoordinatesAction,
  setPositionAction,
} from "viewer/model/actions/flycam_actions";
import {
  setSelectedSegmentsOrGroupAction,
  updateSegmentAction,
} from "viewer/model/actions/volumetracing_actions";
import { rgbaToCSS } from "viewer/shaders/utils.glsl";
import type { Segment } from "viewer/store";
import Store from "viewer/store";
import { getContextMenuPositionFromEvent } from "viewer/view/context_menu/helpers";
import PredictionsView from "viewer/view/right_border_tabs/predictions_tab/predictions_view";
import { ContextMenuContainer } from "viewer/view/right_border_tabs/sidebar_context_menu";
import {
  type CandidateScores,
  getIdentityStatus,
  getSegmentIdentity,
  type IdentityStatus,
  type SegmentIdentity,
  withConfirmedIdentity,
  withIgnored,
  withUnconfirmedIdentity,
  withUnignored,
} from "./neuron_identity_metadata";

const CONTEXT_MENU_OVERLAY_CLASS = "neuron-identity-context-menu-overlay";

const { Text } = Typography;

type SortKey = "confidence" | "id";

type IdentityRow = {
  segment: Segment;
  identity: SegmentIdentity;
  status: IdentityStatus;
};

const STATUS_TAG_COLOR: Record<IdentityStatus, string | undefined> = {
  predicted: "blue",
  confirmed: "green",
  none: undefined,
};

const STATUS_LABEL: Record<IdentityStatus, string> = {
  predicted: "predicted",
  confirmed: "confirmed",
  none: "unlabeled",
};

function formatScore(score: number): string {
  return Number.isFinite(score) ? `${Math.round(score * 100)}%` : "–";
}

/** 32-bit FNV-1a hash of a string. */
function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Finalizer from MurmurHash3 (the "fmix32" step) — FNV-1a alone still leaves
 * enough structure in short, similarly-charactered inputs (neuron names like
 * "ADEL"/"ADAR"/"AVAL" sharing a charset and length) that `% 360` on the raw
 * hash clumped most of them into the same hue band in practice. Re-mixing
 * with a few xorshift/multiply rounds breaks that up so near-identical inputs
 * land in uncorrelated parts of the output range.
 */
function finalizeHash(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Deterministic background/text color for a candidate name — same name
 * always gets the same color (a pure hash of the string, no lookup table or
 * state), so a name is visually recognizable across tags/rows without any
 * hover tracking.
 */
function colorForName(name: string): { background: string; color: string } {
  const hash = finalizeHash(fnv1aHash(name));
  const hue = hash % 360;
  const saturation = 55 + ((hash >>> 9) % 45); // 55–99%
  const lightness = 78 + ((hash >>> 16) % 18); // 78–95%
  return {
    background: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    color: `hsl(${hue}, ${saturation}%, 20%)`,
  };
}

/** All sources with a score for ANY candidate of this segment — the denominator for averageScore. */
function allSourcesFor(candidates: CandidateScores[]): string[] {
  const sources = new Set<string>();
  for (const candidate of candidates) {
    for (const source of Object.keys(candidate.scoresBySource)) {
      sources.add(source);
    }
  }
  return Array.from(sources);
}

/** Average of this candidate's score across every source present for the segment, missing = 0. */
function averageScore(candidate: CandidateScores, sources: string[]): number {
  if (sources.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const total = sources.reduce((sum, source) => sum + (candidate.scoresBySource[source] ?? 0), 0);
  return total / sources.length;
}

/** All candidates regrouped by source, each source's candidates sorted by that source's own score. */
function groupCandidatesBySource(
  candidates: CandidateScores[],
): { source: string; candidates: { name: string; score: number }[] }[] {
  const namesBySource = new Map<string, { name: string; score: number }[]>();
  for (const candidate of candidates) {
    for (const [source, score] of Object.entries(candidate.scoresBySource)) {
      const list = namesBySource.get(source) ?? [];
      list.push({ name: candidate.name, score });
      namesBySource.set(source, list);
    }
  }
  return Array.from(namesBySource.entries())
    .map(([source, names]) => ({
      source,
      candidates: names.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Candidate names ranked by their cross-source average score (missing source = 0), for the "average" summary row. */
function averageCandidateRanking(
  candidates: CandidateScores[],
): { name: string; score: number }[] {
  const sources = allSourcesFor(candidates);
  return candidates
    .map((candidate) => ({ name: candidate.name, score: averageScore(candidate, sources) }))
    .sort((a, b) => b.score - a.score);
}

/** This segment's best candidate's cross-source average score (missing source = 0), for sorting with no name query. */
function topCandidateAverageScore(identity: SegmentIdentity): number {
  const top = averageCandidateRanking(identity.candidates)[0];
  return top != null ? top.score : Number.NEGATIVE_INFINITY;
}

/** This segment's cross-source average score for ONE specific name, or -Infinity if it's not a candidate at all. */
function averageScoreForName(identity: SegmentIdentity, name: string): number {
  const candidate = identity.candidates.find((c) => c.name === name);
  if (candidate == null) {
    return Number.NEGATIVE_INFINITY;
  }
  return averageScore(candidate, allSourcesFor(identity.candidates));
}

function IdentityListItem({
  row,
  allowUpdate,
  isActive,
  highlightName,
  onGoTo,
  onConfirm,
  onUnconfirm,
  onTagContextMenu,
  onRowContextMenu,
}: {
  row: IdentityRow;
  allowUpdate: boolean;
  isActive: boolean;
  /** A candidate name to visually call out in this row, e.g. the query in Search by Name. */
  highlightName?: string;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onUnconfirm: (segment: Segment) => void;
  /** Right-click on a candidate tag: "Search by name" / "Exclude name" menu. */
  onTagContextMenu: (event: MouseEvent<HTMLElement>, row: IdentityRow, name: string) => void;
  /** Right-click on the row outside a tag: "Ignore segment" menu. */
  onRowContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
}) {
  const { segment, identity, status } = row;
  const segmentColorRGBA = useWkSelector(
    (state) => getSegmentColorAsRGBA(state, segment.id),
    (a: Vector4, b: Vector4) => V4.isEqual(a, b),
  );
  // Deliberately NOT falling back to segment.name here: that's WK's native
  // per-segment name field, set independently of our identity-confirmation
  // system (e.g. leftover from before free-text editing was removed from
  // this row) — showing it would let the name field disagree with the
  // status tag (e.g. "unlabeled" but a name still showing).
  const displayName = identity.confirmed;
  const sourceGroups = groupCandidatesBySource(identity.candidates);
  // Averaging across exactly one source just restates that source's own
  // numbers, so the "average" row only earns its keep with 2+ sources.
  const averageRanking =
    sourceGroups.length > 1 ? averageCandidateRanking(identity.candidates) : [];

  const renderCandidateTag = (name: string, score: number) => {
    const isConfirmed = identity.confirmed === name;
    const isHighlighted = highlightName != null && name === highlightName;
    const nameColor = colorForName(name);
    return (
      <Tooltip
        key={name}
        title={
          allowUpdate
            ? `Click to ${isConfirmed ? "unconfirm" : "confirm"} — right-click for more options`
            : "Right-click for more options"
        }
      >
        <Tag
          icon={isConfirmed ? <CheckOutlined /> : undefined}
          style={{
            cursor: "pointer",
            marginInlineEnd: 0,
            flexShrink: 0,
            // Deterministic per-name color so the same name is visually
            // recognizable at a glance across tags/rows — green (below)
            // overrides this for the confirmed tag instead of stacking.
            background: nameColor.background,
            color: nameColor.color,
            borderColor: nameColor.background,
            ...(isConfirmed && {
              background: "#389e0d",
              borderColor: "#389e0d",
              color: "black",
              fontWeight: 600,
              // Simulate a "pressed" button look for the chosen identity.
              boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.3)",
            }),
            ...(isHighlighted &&
              !isConfirmed && {
                outline: "2px solid #faad14",
                outlineOffset: -1,
              }),
          }}
          onClick={
            allowUpdate
              ? () => {
                  if (isConfirmed) {
                    onUnconfirm(segment);
                  } else {
                    onConfirm(segment, name);
                  }
                }
              : undefined
          }
          onContextMenu={(event) => {
            // Open the tag's own menu instead of the row's — stop it from
            // bubbling up to the row div this tag sits inside.
            event.preventDefault();
            event.stopPropagation();
            onTagContextMenu(event, row, name);
          }}
        >
          {name} {formatScore(score)}
        </Tag>
      </Tooltip>
    );
  };

  return (
    <div
      onClick={() => onGoTo(segment)}
      onContextMenu={(event) => onRowContextMenu(event, row)}
      style={{
        borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
        padding: "6px 8px",
        background: isActive ? "rgba(24,144,255,0.08)" : undefined,
        opacity: identity.ignored ? 0.5 : 1,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 2,
            background: rgbaToCSS(segmentColorRGBA),
            flex: "0 0 auto",
          }}
        />
        <Tooltip
          title={
            segment.anchorPosition != null
              ? "Go to segment"
              : "Position unknown — cannot go to this segment yet"
          }
        >
          <AimOutlined style={{ opacity: segment.anchorPosition == null ? 0.3 : 1 }} />
        </Tooltip>
        <Text style={{ fontVariantNumeric: "tabular-nums" }}>
          #{segment.id}
        </Text>
        <Text strong ellipsis style={{ flex: 1 }}>
          {displayName ?? <Text>unnamed</Text>}
        </Text>
        {identity.ignored && (
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            ignored
          </Tag>
        )}
        <Tag
          color={STATUS_TAG_COLOR[status]}
          style={{ marginInlineEnd: 0, ...(status === "confirmed" && { color: "black" }) }}
        >
          {STATUS_LABEL[status]}
        </Tag>
      </div>

      {(averageRanking.length > 0 || sourceGroups.length > 0) && (
        <div style={{ margin: "6px 0 4px 20px" }}>
          {averageRanking.length > 0 && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 2 }}>
              <Text
                strong
                style={{ fontSize: 14, flex: "0 0 auto", maxWidth: 160 }}
                ellipsis
                title="Average across all sources (missing source counts as 0)"
              >
                average
              </Text>
              <div
                style={{
                  display: "flex",
                  flexWrap: "nowrap",
                  gap: 4,
                  overflowX: "auto",
                  // Reserve space below the tags for the scrollbar track so it
                  // doesn't render on top of the last row of tags — without
                  // this, a right-click meant for a tag can land on the
                  // scrollbar instead and get misattributed to the row below.
                  paddingBottom: 6,
                  marginBottom: -6,
                }}
              >
                {averageRanking.map(({ name, score }) => renderCandidateTag(name, score))}
              </div>
            </div>
          )}
          {sourceGroups.map(({ source, candidates }) => (
            <div
              key={source}
              style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 2 }}
            >
              <Text
                style={{ fontSize: 14, flex: "0 0 auto", maxWidth: 160 }}
                ellipsis
                title={source}
              >
                {source}
              </Text>
              <div
                style={{
                  display: "flex",
                  flexWrap: "nowrap",
                  gap: 4,
                  overflowX: "auto",
                  paddingBottom: 6,
                  marginBottom: -6,
                }}
              >
                {candidates.map(({ name, score }) => renderCandidateTag(name, score))}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

/**
 * The reverse lookup of the main Proofreading list: instead of "for this
 * segment, which names might it be", this answers "for this NAME, which
 * segments might it be" — ranking every segment in the list by its
 * cross-source average score for exactly the typed name (segments where
 * that name isn't a candidate at all sort last, via -Infinity).
 */
function SearchByNameView({
  allRows,
  allowUpdate,
  activeCellId,
  query,
  onQueryChange,
  ignoredNames,
  allSources,
  disabledSources,
  onToggleSource,
  onGoTo,
  onConfirm,
  onUnconfirm,
  onTagContextMenu,
  onRowContextMenu,
}: {
  allRows: IdentityRow[];
  allowUpdate: boolean;
  activeCellId: bigint | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  /** Names excluded from autocomplete suggestions (see ID Prediction's ignored-names list). */
  ignoredNames: string[];
  /** Every source seen across all segments' candidates — the "Matching scores" checkbox list's population. */
  allSources: string[];
  /** Sources unchecked in "Matching scores" — excluded from display and the cross-source average panel-wide. */
  disabledSources: Set<string>;
  onToggleSource: (source: string, enabled: boolean) => void;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onUnconfirm: (segment: Segment) => void;
  onTagContextMenu: (event: MouseEvent<HTMLElement>, row: IdentityRow, name: string) => void;
  onRowContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
}) {
  // By default ("Exclude confirmed neurons" checked), a segment already
  // confirmed as a DIFFERENT name is excluded from both the results list and
  // the autocomplete's suggestions — it can't be confirmed as the searched
  // name anyway (see the duplicate-name guard in handleConfirm), so
  // surfacing it as a "match" or suggesting its name is just noise.
  // Unchecking is the escape hatch for the rare case of wanting to
  // reconsider/reassign an already-confirmed segment.
  const [includeConfirmedElsewhere, setIncludeConfirmedElsewhere] = useState(false);
  // Segments marked "ignore (not a neuron)" are hidden from results by
  // default — they're excluded from matching entirely, so surfacing them
  // here is just clutter. Unchecking is the escape hatch for the rare case
  // of wanting to review/un-ignore one.
  const [includeIgnored, setIncludeIgnored] = useState(false);
  // Off by default: when on, only segments with a score from EVERY enabled
  // "Matching scores" source (on at least one candidate) are shown — useful
  // for comparing sources apples-to-apples instead of segments where most
  // sources simply never ran.
  const [requireAllEnabledSources, setRequireAllEnabledSources] = useState(false);
  const enabledSources = useMemo(
    () => allSources.filter((source) => !disabledSources.has(source)),
    [allSources, disabledSources],
  );
  // Only used when the Name query is empty — ranking by one specific name's
  // score takes priority whenever a name IS typed, since that's a much more
  // targeted order than any of these generic options.
  const [sortBy, setSortBy] = useState<SortKey>("confidence");
  const trimmedQuery = query.trim();

  // Every candidate name seen across all segments' predictions/offline-CSV
  // results so far — the autocomplete's suggestion pool. Local and free (no
  // network call), but only covers names a prediction has actually surfaced;
  // a name with zero predictions anywhere won't be suggested even if it's a
  // real neuron.
  const confirmedNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of allRows) {
      if (row.identity.confirmed != null) {
        names.add(row.identity.confirmed);
      }
    }
    return names;
  }, [allRows]);

  const ignoredNameSet = useMemo(() => new Set(ignoredNames), [ignoredNames]);

  const knownNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of allRows) {
      for (const candidate of row.identity.candidates) {
        if (ignoredNameSet.has(candidate.name)) {
          continue;
        }
        if (includeConfirmedElsewhere || !confirmedNames.has(candidate.name)) {
          names.add(candidate.name);
        }
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allRows, confirmedNames, includeConfirmedElsewhere, ignoredNameSet]);

  const nameOptions = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const filtered =
      lowerQuery.length === 0
        ? knownNames
        : knownNames.filter((name) => name.toLowerCase().startsWith(lowerQuery));
    return filtered.map((name) => ({ value: name }));
  }, [knownNames, query]);

  const matches = useMemo(() => {
    let filtered = allRows;
    if (trimmedQuery.length > 0) {
      filtered = filtered.filter((row) =>
        Number.isFinite(averageScoreForName(row.identity, trimmedQuery)),
      );
    }
    if (!includeConfirmedElsewhere) {
      filtered = filtered.filter(
        (row) => row.identity.confirmed == null || row.identity.confirmed === trimmedQuery,
      );
    }
    if (!includeIgnored) {
      filtered = filtered.filter((row) => !row.identity.ignored);
    }
    if (requireAllEnabledSources && enabledSources.length > 0) {
      filtered = filtered.filter((row) => {
        const sourcesPresent = new Set<string>();
        for (const candidate of row.identity.candidates) {
          for (const source of Object.keys(candidate.scoresBySource)) {
            sourcesPresent.add(source);
          }
        }
        return enabledSources.every((source) => sourcesPresent.has(source));
      });
    }
    return [...filtered].sort((a, b) => {
      if (trimmedQuery.length > 0) {
        return (
          averageScoreForName(b.identity, trimmedQuery) -
          averageScoreForName(a.identity, trimmedQuery)
        );
      }
      if (sortBy === "id") {
        return a.segment.id < b.segment.id ? -1 : a.segment.id > b.segment.id ? 1 : 0;
      }
      // "confidence"
      return topCandidateAverageScore(b.identity) - topCandidateAverageScore(a.identity);
    });
  }, [
    allRows,
    trimmedQuery,
    includeConfirmedElsewhere,
    includeIgnored,
    requireAllEnabledSources,
    enabledSources,
    sortBy,
  ]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 12 }}>Sort by:</Text>
          <Select<SortKey>
            size="small"
            value={sortBy}
            onChange={setSortBy}
            disabled={trimmedQuery.length > 0}
            style={{ width: 140 }}
            options={[
              { label: "Confidence", value: "confidence" },
              { label: "Segment ID", value: "id" },
            ]}
          />
          <Text style={{ fontSize: 12, flex: "0 0 auto" }}>Search by name:</Text>
          <AutoComplete
            value={query}
            onChange={onQueryChange}
            options={nameOptions}
            filterOption={false}
            size="small"
            placeholder="Name…"
            style={{ flex: 1 }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.length > 0) {
                event.stopPropagation();
                onQueryChange("");
              }
            }}
          />
          {query.length > 0 && (
            <Tooltip title="Clear search">
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={() => onQueryChange("")}
              />
            </Tooltip>
          )}
        </div>
        {allSources.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <Text style={{ fontSize: 12, flex: "0 0 auto" }}>Matching scores:</Text>
            {allSources.map((source) => (
              <Checkbox
                key={source}
                checked={!disabledSources.has(source)}
                onChange={(event) => onToggleSource(source, event.target.checked)}
                style={{ fontSize: 12, marginInlineStart: 0 }}
              >
                {source}
              </Checkbox>
            ))}
          </div>
        )}
        <Checkbox
          checked={!includeConfirmedElsewhere}
          onChange={(event) => setIncludeConfirmedElsewhere(!event.target.checked)}
          style={{ marginTop: 8, fontSize: 12 }}
        >
          Exclude confirmed neurons
        </Checkbox>
        <Checkbox
          checked={!includeIgnored}
          onChange={(event) => setIncludeIgnored(!event.target.checked)}
          style={{ marginTop: 4, marginInlineStart: 0, fontSize: 12 }}
        >
          Exclude ignored segments
        </Checkbox>
        {enabledSources.length > 1 && (
          <Checkbox
            checked={requireAllEnabledSources}
            onChange={(event) => setRequireAllEnabledSources(event.target.checked)}
            style={{ marginTop: 4, marginInlineStart: 0, fontSize: 12 }}
          >
            Exclude segments missing scores
          </Checkbox>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {matches.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              trimmedQuery.length > 0
                ? `No segment has "${trimmedQuery}" as a candidate.`
                : "No segments match these filters."
            }
            style={{ marginTop: 40 }}
          />
        ) : (
          matches.map((row) => (
            <IdentityListItem
              key={row.segment.id}
              row={row}
              allowUpdate={allowUpdate}
              isActive={activeCellId === row.segment.id}
              highlightName={trimmedQuery.length > 0 ? trimmedQuery : undefined}
              onGoTo={onGoTo}
              onConfirm={onConfirm}
              onUnconfirm={onUnconfirm}
              onTagContextMenu={onTagContextMenu}
              onRowContextMenu={onRowContextMenu}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Shows exactly one segment: whichever was most recently clicked, either as
 * a voxel in the 2D/3D data viewport or as a row in WK's native Segments
 * panel list — both funnel into the same `selectedIds` store state (see
 * updateClickedSegments in volumetracing_saga.tsx), unlike `activeCellId`,
 * which only visually highlights in Proofreading-tool mode. A multi-select
 * (shift/ctrl-click in the Segments panel) still resolves to "the first of
 * the selection", rather than showing nothing or all of them.
 */
function CurrentSegmentView({
  allRows,
  allowUpdate,
  selectedSegmentId,
  onGoTo,
  onConfirm,
  onUnconfirm,
  onTagContextMenu,
  onRowContextMenu,
}: {
  allRows: IdentityRow[];
  allowUpdate: boolean;
  selectedSegmentId: bigint | undefined;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onUnconfirm: (segment: Segment) => void;
  onTagContextMenu: (event: MouseEvent<HTMLElement>, row: IdentityRow, name: string) => void;
  onRowContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
}) {
  const [segmentIdQuery, setSegmentIdQuery] = useState("");

  const knownSegmentIds = useMemo(
    () => allRows.map((row) => row.segment.id.toString()).sort(),
    [allRows],
  );

  const segmentIdOptions = useMemo(() => {
    const trimmed = segmentIdQuery.trim();
    const filtered =
      trimmed.length === 0
        ? knownSegmentIds
        : knownSegmentIds.filter((id) => id.startsWith(trimmed));
    return filtered.map((id) => ({ value: id }));
  }, [knownSegmentIds, segmentIdQuery]);

  // Typing a segment ID here SELECTS it — same setSelectedSegmentsOrGroupAction
  // dispatch as clicking it in the viewport/panel (via onGoTo) — rather than
  // just locally overriding what this view displays. That keeps "current
  // segment" meaning one single thing everywhere (the shared selectedIds
  // store state), instead of this box silently diverging from it.
  const handleSegmentIdChange = (value: string) => {
    setSegmentIdQuery(value);
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return;
    }
    const segmentId = BigInt(trimmed);
    const matchingRow = allRows.find((row) => row.segment.id === segmentId);
    if (matchingRow != null) {
      onGoTo(matchingRow.segment);
    }
  };

  const currentRow =
    selectedSegmentId != null
      ? allRows.find((row) => row.segment.id === selectedSegmentId)
      : undefined;

  return (
    <div>
      <AutoComplete
        value={segmentIdQuery}
        onChange={handleSegmentIdChange}
        options={segmentIdOptions}
        filterOption={false}
        size="small"
        placeholder="Select segment by ID…"
        style={{ width: "100%", marginBottom: 8 }}
      />
      {currentRow == null ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Click a segment in the data viewport or the Segments panel, or enter its ID above."
          style={{ marginTop: 40 }}
        />
      ) : (
        <IdentityListItem
          row={currentRow}
          allowUpdate={allowUpdate}
          isActive
          onGoTo={onGoTo}
          onConfirm={onConfirm}
          onUnconfirm={onUnconfirm}
          onTagContextMenu={onTagContextMenu}
          onRowContextMenu={onRowContextMenu}
        />
      )}
    </div>
  );
}

export default function NeuronIdentityView() {
  const dispatch = useDispatch();
  const [contextMenuPosition, setContextMenuPosition] = useState<[number, number] | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuProps | null>(null);
  const [subTab, setSubTab] = useState<"predictions" | "searchByName">("predictions");
  // Search by Name's query, lifted here so clicking a candidate tag anywhere
  // (including the main Proofreading list) can populate it and jump to that
  // tab, not just from within Search by Name's own result rows.
  const [searchByNameQuery, setSearchByNameQuery] = useState("");
  const handleSearchName = (name: string) => {
    setSearchByNameQuery(name);
    setSubTab("searchByName");
  };
  // Names excluded from the reference contactome used for live Run matching
  // (ID Prediction tab) and from Search by Name's autocomplete suggestions —
  // lifted here so both tabs see the same list. Not persisted.
  const [ignoredNames, setIgnoredNames] = useState<string[]>([]);
  // Sources (e.g. "prediction:adult", "morphology_scores") excluded from
  // display and from the cross-source average everywhere in this panel —
  // session-local like ignoredNames, not persisted. null means "not
  // explicitly touched yet": every source is treated as enabled until the
  // user unchecks one, so newly-seen sources start enabled rather than
  // silently excluded.
  const [disabledSources, setDisabledSources] = useState<Set<string>>(new Set());
  const [isCurrentSegmentExpanded, setIsCurrentSegmentExpanded] = useState(true);
  const [isConfirmedIdsExpanded, setIsConfirmedIdsExpanded] = useState(true);

  const visibleSegmentationLayer = useWkSelector(getVisibleSegmentationLayer);
  const segments = useWkSelector((state) => getVisibleSegments(state).segments);
  // Mirror the Segments tab: editing is allowed unless a visible-but-untracable
  // segmentation layer (a dataset layer, tracingId == null) is active.
  const allowUpdate = useWkSelector(
    (state) =>
      mayEditAnnotation(state) &&
      !(visibleSegmentationLayer != null && visibleSegmentationLayer.tracingId == null),
  );
  const activeCellId = useWkSelector((state) => {
    const layer = getVisibleSegmentationLayer(state);
    if (layer?.tracingId == null) {
      return undefined;
    }
    return state.annotation.volumes.find((volume) => volume.tracingId === layer.tracingId)
      ?.activeCellId;
  });
  // The segment most recently clicked, either as a voxel in the data
  // viewport or as a row in the Segments panel — both update this same
  // state (see CurrentSegmentView's doc comment). A multi-select resolves to
  // its first entry.
  const selectedSegmentId = useWkSelector((state) => getSelectedIds(state).segments[0]);

  const unfilteredRows = useMemo<IdentityRow[]>(() => {
    if (segments == null) {
      return [];
    }
    return Array.from(segments.values()).map((segment) => {
      const identity = getSegmentIdentity(segment);
      return { segment, identity, status: getIdentityStatus(identity) };
    });
  }, [segments]);

  // Every source seen across all segments' candidates — the "Matching
  // scores" checkbox list's population. Derived from the unfiltered rows so
  // a source doesn't disappear from the list just because the user disabled
  // it (which would make it impossible to re-enable).
  const allSources = useMemo(() => {
    const sources = new Set<string>();
    for (const row of unfilteredRows) {
      for (const candidate of row.identity.candidates) {
        for (const source of Object.keys(candidate.scoresBySource)) {
          sources.add(source);
        }
      }
    }
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }, [unfilteredRows]);

  const handleToggleSource = (source: string, enabled: boolean) => {
    setDisabledSources((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(source);
      } else {
        next.add(source);
      }
      return next;
    });
  };

  // Disabled sources are stripped out of each candidate's scoresBySource
  // (and a candidate left with no remaining source is dropped entirely) here
  // — once, at the top of the panel — so every consumer downstream (Current
  // Segment, Search by Name, Confirmed IDs, the context menu) automatically
  // sees only enabled sources without re-deriving this filter itself.
  const allRows = useMemo<IdentityRow[]>(() => {
    if (disabledSources.size === 0) {
      return unfilteredRows;
    }
    return unfilteredRows.map((row) => {
      const candidates = row.identity.candidates
        .map((candidate) => {
          const scoresBySource = Object.fromEntries(
            Object.entries(candidate.scoresBySource).filter(
              ([source]) => !disabledSources.has(source),
            ),
          );
          return { ...candidate, scoresBySource };
        })
        .filter((candidate) => Object.keys(candidate.scoresBySource).length > 0);
      const identity = { ...row.identity, candidates };
      return { ...row, identity, status: getIdentityStatus(identity) };
    });
  }, [unfilteredRows, disabledSources]);

  const confirmedCount = useMemo(
    () => allRows.filter((row) => row.status === "confirmed").length,
    [allRows],
  );
  const ignoredCount = useMemo(
    () => allRows.filter((row) => row.identity.ignored).length,
    [allRows],
  );
  // Non-ignored segments still without a confirmed name — the gap between
  // confirmedCount and the (ignored-excluded) denominator shown in the title.
  const unnamedSegmentCount = useMemo(
    () => allRows.filter((row) => !row.identity.ignored && row.identity.confirmed == null).length,
    [allRows],
  );
  // Candidate names surfaced by predictions/offline-CSVs for at least one
  // non-ignored segment, but not yet confirmed on ANY segment — distinct from
  // unnamedSegmentCount, which counts segments, not names.
  const unassignedNameCount = useMemo(() => {
    const confirmedNames = new Set<string>();
    const candidateNames = new Set<string>();
    for (const row of allRows) {
      if (row.identity.confirmed != null) {
        confirmedNames.add(row.identity.confirmed);
      }
      if (row.identity.ignored) {
        continue;
      }
      for (const candidate of row.identity.candidates) {
        if (!ignoredNames.includes(candidate.name)) {
          candidateNames.add(candidate.name);
        }
      }
    }
    let count = 0;
    for (const name of candidateNames) {
      if (!confirmedNames.has(name)) {
        count += 1;
      }
    }
    return count;
  }, [allRows, ignoredNames]);

  const handleConfirm = (segment: Segment, name: string) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    const conflictingRow = allRows.find(
      (row) => row.segment.id !== segment.id && row.identity.confirmed === name,
    );
    if (conflictingRow != null) {
      Toast.error(
        `"${name}" is already confirmed on segment #${conflictingRow.segment.id} — clear that confirmation first if you want to reassign it.`,
      );
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        { name, metadata: withConfirmedIdentity(segment.metadata ?? [], name) },
        visibleSegmentationLayer.name,
        undefined,
        true,
      ),
    );
  };

  const handleGoTo = (segment: Segment) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(setSelectedSegmentsOrGroupAction([segment.id], null, visibleSegmentationLayer.name));
    if (!segment.anchorPosition) {
      Toast.info("Cannot go to this segment, because its position is unknown.");
      return;
    }
    const transformedPosition = layerToGlobalTransformedPosition(
      segment.anchorPosition,
      visibleSegmentationLayer.name,
      "segmentation",
      Store.getState(),
    );
    dispatch(setPositionAction(transformedPosition));
    if (segment.additionalCoordinates != null) {
      dispatch(setAdditionalCoordinatesAction(segment.additionalCoordinates));
    }
  };

  const handleResetDecision = (segment: Segment) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        { metadata: withUnconfirmedIdentity(segment.metadata ?? []) },
        visibleSegmentationLayer.name,
        undefined,
        true,
      ),
    );
  };

  const handleToggleIgnored = (segment: Segment, ignored: boolean) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        {
          metadata: (ignored ? withIgnored : withUnignored)(segment.metadata ?? []),
        },
        visibleSegmentationLayer.name,
        undefined,
        true,
      ),
    );
  };

  const hideContextMenu = () => {
    setContextMenuPosition(null);
    setContextMenu(null);
  };

  const showContextMenuAt = (xPos: number, yPos: number, menu: MenuProps) => {
    // Delay the state update by a tick so the same right-click that opens the menu
    // isn't also delivered to the freshly-rendered overlay (which would close it).
    setTimeout(() => {
      setContextMenuPosition([xPos, yPos]);
      setContextMenu(menu);
    }, 0);
  };

  // Row right-click (outside a candidate tag): just the ignore toggle — goto
  // is now the row's plain click, and confirm/color/remove moved to the
  // tag-level interactions below (or were dropped).
  const buildRowContextMenu = (row: IdentityRow): MenuProps => {
    const { segment, identity } = row;
    const withHide = (fn: () => void) => () => {
      hideContextMenu();
      fn();
    };
    return {
      items: [
        {
          key: "toggleIgnored",
          label: identity.ignored ? "Un-ignore segment" : "Ignore segment (not a neuron)",
          disabled: !allowUpdate,
          onClick: withHide(() => handleToggleIgnored(segment, !identity.ignored)),
        },
      ],
    };
  };

  // Candidate-tag right-click: search for the name elsewhere, or exclude it
  // from matching entirely (confirm/unconfirm is the tag's plain click).
  const buildTagContextMenu = (row: IdentityRow, name: string): MenuProps => {
    const withHide = (fn: () => void) => () => {
      hideContextMenu();
      fn();
    };
    return {
      items: [
        {
          key: "searchByName",
          label: "Search by name",
          onClick: withHide(() => handleSearchName(name)),
        },
        {
          key: "excludeName",
          label: "Exclude name",
          disabled: !allowUpdate || ignoredNames.includes(name),
          onClick: withHide(() => {
            if (!ignoredNames.includes(name)) {
              setIgnoredNames([...ignoredNames, name]);
            }
          }),
        },
      ],
    };
  };

  const onRowContextMenu = (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => {
    event.preventDefault();
    const [x, y] = getContextMenuPositionFromEvent(event, CONTEXT_MENU_OVERLAY_CLASS);
    showContextMenuAt(x, y, buildRowContextMenu(row));
  };

  const onTagContextMenu = (event: MouseEvent<HTMLElement>, row: IdentityRow, name: string) => {
    const [x, y] = getContextMenuPositionFromEvent(event, CONTEXT_MENU_OVERLAY_CLASS);
    showContextMenuAt(x, y, buildTagContextMenu(row, name));
  };

  if (visibleSegmentationLayer == null) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No visible segmentation layer."
        style={{ marginTop: 40 }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ContextMenuContainer
        hideContextMenu={hideContextMenu}
        contextMenuPosition={contextMenuPosition}
        menu={contextMenu}
        className={CONTEXT_MENU_OVERLAY_CLASS}
      />

      <div
        style={{
          padding: 8,
          borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
          flex: "0 0 auto",
        }}
      >
        <Button
          type="text"
          size="small"
          style={{ padding: 0, height: "auto", fontWeight: "bold", fontSize: 12 }}
          icon={isCurrentSegmentExpanded ? <CaretUpOutlined /> : <CaretDownOutlined />}
          iconPosition="end"
          onClick={() => setIsCurrentSegmentExpanded((expanded) => !expanded)}
        >
          Current segment
        </Button>
        {isCurrentSegmentExpanded && (
          <div style={{ marginTop: 4 }}>
            <CurrentSegmentView
              allRows={allRows}
              allowUpdate={allowUpdate}
              selectedSegmentId={selectedSegmentId}
              onGoTo={handleGoTo}
              onConfirm={handleConfirm}
              onUnconfirm={handleResetDecision}
              onTagContextMenu={onTagContextMenu}
              onRowContextMenu={onRowContextMenu}
            />
          </div>
        )}
      </div>

      <Tabs
        activeKey={subTab}
        onChange={(key) => setSubTab(key as "predictions" | "searchByName")}
        size="small"
        tabBarStyle={{ paddingInline: 8, marginBottom: 0 }}
        items={[
          { key: "predictions", label: "Predict IDs" },
          { key: "searchByName", label: "Proofread IDs" },
        ]}
      />

      {/*
        All sub-tabs stay mounted (toggled via `display`) rather than being
        conditionally rendered, so panel-local state — e.g. the Predictions
        tab's in-memory contact profile, or the Search by Name query — survives
        switching sub-tabs.
      */}
      <div
        style={{ flex: 1, minHeight: 0, display: subTab === "predictions" ? undefined : "none" }}
      >
        <PredictionsView ignoredNames={ignoredNames} onIgnoredNamesChange={setIgnoredNames} />
      </div>
      <div
        style={{ flex: 1, minHeight: 0, display: subTab === "searchByName" ? undefined : "none" }}
      >
        <SearchByNameView
          allRows={allRows}
          allowUpdate={allowUpdate}
          activeCellId={activeCellId}
          query={searchByNameQuery}
          onQueryChange={setSearchByNameQuery}
          ignoredNames={ignoredNames}
          allSources={allSources}
          disabledSources={disabledSources}
          onToggleSource={handleToggleSource}
          onGoTo={handleGoTo}
          onConfirm={handleConfirm}
          onUnconfirm={handleResetDecision}
          onTagContextMenu={onTagContextMenu}
          onRowContextMenu={onRowContextMenu}
        />
      </div>

      <div
        style={{
          padding: 8,
          borderTop: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
          flex: "0 0 auto",
        }}
      >
        <Button
          type="text"
          size="small"
          style={{ padding: 0, height: "auto", fontWeight: "bold", fontSize: 12 }}
          icon={isConfirmedIdsExpanded ? <CaretUpOutlined /> : <CaretDownOutlined />}
          iconPosition="end"
          onClick={() => setIsConfirmedIdsExpanded((expanded) => !expanded)}
        >
          Confirmed IDs ({confirmedCount})
        </Button>
        {isConfirmedIdsExpanded && confirmedCount === 0 && (
          <Text style={{ display: "block", fontSize: 12, marginTop: 4 }}>
            No confirmed identities yet.
          </Text>
        )}
        {isConfirmedIdsExpanded && confirmedCount > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 80, overflowY: "auto" }}>
            {allRows
              .filter(
                (row): row is IdentityRow & { identity: { confirmed: string } } =>
                  row.identity.confirmed != null,
              )
              .sort((a, b) => a.identity.confirmed.localeCompare(b.identity.confirmed))
              .map((row) => (
                <Tooltip
                  key={row.segment.id}
                  title={
                    allowUpdate ? "Click to select — right-click to unconfirm" : "Click to select"
                  }
                >
                  <Tag
                    color="green"
                    style={{ cursor: "pointer", color: "black" }}
                    onClick={() => handleGoTo(row.segment)}
                    onContextMenu={
                      allowUpdate
                        ? (event) => {
                            event.preventDefault();
                            handleResetDecision(row.segment);
                          }
                        : undefined
                    }
                  >
                    {row.identity.confirmed} (#{row.segment.id})
                  </Tag>
                </Tooltip>
              ))}
          </div>
        )}
        {isConfirmedIdsExpanded && (
          <Text style={{ display: "block", fontSize: 12, marginTop: 4 }}>
            {unnamedSegmentCount} segment{unnamedSegmentCount === 1 ? "" : "s"} unnamed,{" "}
            {unassignedNameCount} name{unassignedNameCount === 1 ? "" : "s"} unassigned
          </Text>
        )}
        {isConfirmedIdsExpanded && (
          <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ display: "block", fontSize: 12, fontWeight: "bold" }}>
                Excluded Segments ({ignoredCount})
              </Text>
              {ignoredCount === 0 ? (
                <Text style={{ display: "block", fontSize: 12, marginTop: 4 }}>None.</Text>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    maxHeight: 80,
                    overflowY: "auto",
                    marginTop: 4,
                  }}
                >
                  {allRows
                    .filter((row) => row.identity.ignored)
                    .sort((a, b) => (a.segment.id < b.segment.id ? -1 : 1))
                    .map((row) => (
                      <Tooltip
                        key={row.segment.id}
                        title={
                          allowUpdate
                            ? "Click to select — right-click to un-ignore"
                            : "Click to select"
                        }
                      >
                        <Tag
                          color="default"
                          style={{ cursor: "pointer" }}
                          onClick={() => handleGoTo(row.segment)}
                          onContextMenu={
                            allowUpdate
                              ? (event) => {
                                  event.preventDefault();
                                  handleToggleIgnored(row.segment, false);
                                }
                              : undefined
                          }
                        >
                          #{row.segment.id}
                        </Tag>
                      </Tooltip>
                    ))}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ display: "block", fontSize: 12, fontWeight: "bold" }}>
                Ignored Names ({ignoredNames.length})
              </Text>
              {ignoredNames.length === 0 ? (
                <Text style={{ display: "block", fontSize: 12, marginTop: 4 }}>None.</Text>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    maxHeight: 80,
                    overflowY: "auto",
                    marginTop: 4,
                  }}
                >
                  {ignoredNames.map((name) => (
                    <Tag
                      key={name}
                      closable
                      onClose={() => setIgnoredNames(ignoredNames.filter((n) => n !== name))}
                    >
                      {name}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
