import {
  AimOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import {
  AutoComplete,
  Button,
  Checkbox,
  Empty,
  type MenuProps,
  Segmented,
  Select,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ChangeColorMenuItemContent } from "components/color_picker";
import { V4 } from "libs/mjs";
import { useWkSelector } from "libs/react_hooks";
import Toast from "libs/toast";
import { type MouseEvent, useMemo, useState } from "react";
import { useDispatch } from "react-redux";
import type { Vector3, Vector4 } from "viewer/constants";
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
  removeSegmentAction,
  setActiveCellAction,
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
  withUnconfirmedIdentity,
} from "./neuron_identity_metadata";

const CONTEXT_MENU_OVERLAY_CLASS = "neuron-identity-context-menu-overlay";

const { Text } = Typography;

type FilterKey = "all" | "review" | "confirmed";
type SortKey = "confidence" | "id" | "name";

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

function matchesFilter(status: IdentityStatus, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review":
      return status === "predicted";
    case "confirmed":
      return status === "confirmed";
  }
}

/** This segment's best candidate's cross-source average score (missing source = 0), for sorting. */
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
  onSearchName,
  onContextMenu,
}: {
  row: IdentityRow;
  allowUpdate: boolean;
  isActive: boolean;
  /** A candidate name to visually call out in this row, e.g. the query in Search by Name. */
  highlightName?: string;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  /** Double-click on the ALREADY-confirmed tag: clear the confirmation instead of re-confirming it. */
  onUnconfirm: (segment: Segment) => void;
  /** Single-click on a candidate tag: search for that name instead of confirming. */
  onSearchName: (name: string) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
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
  const averageRanking = averageCandidateRanking(identity.candidates);

  const renderCandidateTag = (name: string, score: number) => {
    const isConfirmed = identity.confirmed === name;
    const isHighlighted = highlightName != null && name === highlightName;
    return (
      <Tooltip
        key={name}
        title={
          allowUpdate
            ? `Click to search — right-click to ${isConfirmed ? "unconfirm" : "confirm"}`
            : "Click to search"
        }
      >
        <Tag
          color={isConfirmed ? "green" : undefined}
          icon={isConfirmed ? <CheckOutlined /> : undefined}
          style={{
            cursor: "pointer",
            marginInlineEnd: 0,
            flexShrink: 0,
            ...(isConfirmed && {
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
          onClick={() => onSearchName(name)}
          onContextMenu={
            allowUpdate
              ? (event) => {
                  // Confirm/unconfirm instead of opening the row's own
                  // context menu (bound on the row div this tag sits
                  // inside) — stop it from bubbling up.
                  event.preventDefault();
                  event.stopPropagation();
                  if (isConfirmed) {
                    onUnconfirm(segment);
                  } else {
                    onConfirm(segment, name);
                  }
                }
              : undefined
          }
        >
          {name} {formatScore(score)}
        </Tag>
      </Tooltip>
    );
  };

  return (
    <div
      onContextMenu={(event) => onContextMenu(event, row)}
      style={{
        borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
        padding: "6px 8px",
        background: isActive ? "rgba(24,144,255,0.08)" : undefined,
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
          <Button
            size="small"
            type="text"
            icon={<AimOutlined />}
            disabled={segment.anchorPosition == null}
            onClick={() => onGoTo(segment)}
          />
        </Tooltip>
        <Text style={{ fontVariantNumeric: "tabular-nums" }}>
          #{segment.id}
        </Text>
        <Text strong ellipsis style={{ flex: 1 }}>
          {displayName ?? <Text>unnamed</Text>}
        </Text>
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
              <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, overflowX: "auto" }}>
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
              <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, overflowX: "auto" }}>
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
  onGoTo,
  onConfirm,
  onUnconfirm,
  onContextMenu,
}: {
  allRows: IdentityRow[];
  allowUpdate: boolean;
  activeCellId: bigint | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onUnconfirm: (segment: Segment) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
}) {
  // By default ("Exclude confirmed neurons" checked), a segment already
  // confirmed as a DIFFERENT name is excluded from both the results list and
  // the autocomplete's suggestions — it can't be confirmed as the searched
  // name anyway (see the duplicate-name guard in handleConfirm), so
  // surfacing it as a "match" or suggesting its name is just noise.
  // Unchecking is the escape hatch for the rare case of wanting to
  // reconsider/reassign an already-confirmed segment.
  const [includeConfirmedElsewhere, setIncludeConfirmedElsewhere] = useState(false);
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

  const knownNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of allRows) {
      for (const candidate of row.identity.candidates) {
        if (includeConfirmedElsewhere || !confirmedNames.has(candidate.name)) {
          names.add(candidate.name);
        }
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allRows, confirmedNames, includeConfirmedElsewhere]);

  const nameOptions = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const filtered =
      lowerQuery.length === 0
        ? knownNames
        : knownNames.filter((name) => name.toLowerCase().startsWith(lowerQuery));
    return filtered.map((name) => ({ value: name }));
  }, [knownNames, query]);

  const matches = useMemo(() => {
    if (trimmedQuery.length === 0) {
      return [];
    }
    let filtered = allRows.filter((row) =>
      Number.isFinite(averageScoreForName(row.identity, trimmedQuery)),
    );
    if (!includeConfirmedElsewhere) {
      filtered = filtered.filter(
        (row) => row.identity.confirmed == null || row.identity.confirmed === trimmedQuery,
      );
    }
    return [...filtered].sort(
      (a, b) =>
        averageScoreForName(b.identity, trimmedQuery) -
        averageScoreForName(a.identity, trimmedQuery),
    );
  }, [allRows, trimmedQuery, includeConfirmedElsewhere]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
        }}
      >
        <AutoComplete
          value={query}
          onChange={onQueryChange}
          options={nameOptions}
          filterOption={false}
          size="small"
          placeholder="Name…"
          style={{ width: "100%" }}
        />
        <Checkbox
          checked={!includeConfirmedElsewhere}
          onChange={(event) => setIncludeConfirmedElsewhere(!event.target.checked)}
          style={{ marginTop: 8, fontSize: 12 }}
        >
          Exclude confirmed neurons
        </Checkbox>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {trimmedQuery.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Type a neuron name to see which segments might match."
            style={{ marginTop: 40 }}
          />
        ) : matches.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`No segment has "${trimmedQuery}" as a candidate.`}
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
              onSearchName={onQueryChange}
              onContextMenu={onContextMenu}
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
  onSearchName,
  onContextMenu,
}: {
  allRows: IdentityRow[];
  allowUpdate: boolean;
  selectedSegmentId: bigint | undefined;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onUnconfirm: (segment: Segment) => void;
  onSearchName: (name: string) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
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
          onSearchName={onSearchName}
          onContextMenu={onContextMenu}
        />
      )}
    </div>
  );
}

export default function NeuronIdentityView() {
  const dispatch = useDispatch();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sortBy, setSortBy] = useState<SortKey>("confidence");
  const [contextMenuPosition, setContextMenuPosition] = useState<[number, number] | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuProps | null>(null);
  const [subTab, setSubTab] = useState<"proofread" | "predictions" | "searchByName">("proofread");
  // Search by Name's query, lifted here so clicking a candidate tag anywhere
  // (including the main Proofreading list) can populate it and jump to that
  // tab, not just from within Search by Name's own result rows.
  const [searchByNameQuery, setSearchByNameQuery] = useState("");
  const handleSearchName = (name: string) => {
    setSearchByNameQuery(name);
    setSubTab("searchByName");
  };
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

  const allRows = useMemo<IdentityRow[]>(() => {
    if (segments == null) {
      return [];
    }
    return Array.from(segments.values()).map((segment) => {
      const identity = getSegmentIdentity(segment);
      return { segment, identity, status: getIdentityStatus(identity) };
    });
  }, [segments]);

  const visibleRows = useMemo<IdentityRow[]>(() => {
    const filtered = allRows.filter((row) => matchesFilter(row.status, filter));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortBy === "id") {
        return a.segment.id < b.segment.id ? -1 : a.segment.id > b.segment.id ? 1 : 0;
      }
      if (sortBy === "name") {
        const nameA = a.identity.confirmed ?? "";
        const nameB = b.identity.confirmed ?? "";
        return nameA.localeCompare(nameB);
      }
      // "confidence"
      return topCandidateAverageScore(b.identity) - topCandidateAverageScore(a.identity);
    });
    return sorted;
  }, [allRows, filter, sortBy]);

  const confirmedCount = useMemo(
    () => allRows.filter((row) => row.status === "confirmed").length,
    [allRows],
  );

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

  const handleMakeActive = (segment: Segment) => {
    dispatch(
      setActiveCellAction(segment.id, segment.anchorPosition, segment.additionalCoordinates),
    );
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

  const handleSetColor = (segment: Segment, color: Vector3, createsNewUndoState: boolean) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        { color },
        visibleSegmentationLayer.name,
        undefined,
        createsNewUndoState,
      ),
    );
  };

  const handleRemove = (segment: Segment) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(removeSegmentAction(segment.id, visibleSegmentationLayer.name));
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

  const buildContextMenu = (row: IdentityRow): MenuProps => {
    const { segment, identity } = row;
    const withHide = (fn: () => void) => () => {
      hideContextMenu();
      fn();
    };

    const items: MenuProps["items"] = [
      {
        key: "goto",
        label:
          segment.anchorPosition != null ? "Go to segment" : "Go to segment (position unknown)",
        disabled: segment.anchorPosition == null,
        onClick: withHide(() => handleGoTo(segment)),
      },
      {
        key: "makeActive",
        label: "Make active cell",
        onClick: withHide(() => handleMakeActive(segment)),
      },
    ];

    if (allowUpdate) {
      items.push({ type: "divider" });
      if (identity.candidates.length > 0) {
        const averageScoreByName = new Map(
          averageCandidateRanking(identity.candidates).map((c) => [c.name, c.score]),
        );
        items.push({
          key: "confirmCandidate",
          label: "Confirm identity",
          children: identity.candidates.map((candidate) => ({
            key: `confirm-${candidate.name}`,
            label: `${candidate.name} ${formatScore(averageScoreByName.get(candidate.name) ?? Number.NEGATIVE_INFINITY)}`,
            onClick: withHide(() => handleConfirm(segment, candidate.name)),
          })),
        });
      }
      if (identity.confirmed != null) {
        items.push({
          key: "reset",
          label: "Clear confirmed identity",
          onClick: withHide(() => handleResetDecision(segment)),
        });
      }
      items.push({ type: "divider" });
      items.push({
        key: "color",
        label: (
          <ChangeColorMenuItemContent
            isDisabled={false}
            title="Change color"
            onSetColor={(color, createsNewUndoState) =>
              handleSetColor(segment, color, createsNewUndoState)
            }
            rgb={getSegmentColorAsRGBA(Store.getState(), segment.id).slice(0, 3) as Vector3}
          />
        ),
      });
      items.push({
        key: "remove",
        danger: true,
        label: "Remove from segment list",
        onClick: withHide(() => handleRemove(segment)),
      });
    }

    return { items };
  };

  const onRowContextMenu = (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => {
    event.preventDefault();
    const [x, y] = getContextMenuPositionFromEvent(event, CONTEXT_MENU_OVERLAY_CLASS);
    showContextMenuAt(x, y, buildContextMenu(row));
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
              onSearchName={handleSearchName}
              onContextMenu={onRowContextMenu}
            />
          </div>
        )}
      </div>

      <Tabs
        activeKey={subTab}
        onChange={(key) => setSubTab(key as "proofread" | "predictions" | "searchByName")}
        size="small"
        tabBarStyle={{ paddingInline: 8, marginBottom: 0 }}
        items={[
          { key: "proofread", label: "Proofreading" },
          { key: "predictions", label: "ID Prediction" },
          { key: "searchByName", label: "Search by Name" },
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
        <PredictionsView />
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
          onGoTo={handleGoTo}
          onConfirm={handleConfirm}
          onUnconfirm={handleResetDecision}
          onContextMenu={onRowContextMenu}
        />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: subTab === "proofread" ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: 8,
            borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
          }}
        >
          <Text style={{ display: "block" }}>
            {confirmedCount} / {allRows.length} confirmed
          </Text>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Segmented<FilterKey>
              size="small"
              value={filter}
              onChange={(value) => setFilter(value)}
              options={[
                { label: "All", value: "all" },
                { label: "Review", value: "review" },
                { label: "Confirmed", value: "confirmed" },
              ]}
            />
            <Select<SortKey>
              size="small"
              value={sortBy}
              onChange={setSortBy}
              style={{ width: 130 }}
              options={[
                { label: "Sort: confidence", value: "confidence" },
                { label: "Sort: segment id", value: "id" },
                { label: "Sort: name", value: "name" },
              ]}
            />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {visibleRows.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                allRows.length === 0 ? "No segments yet." : "No segments match this filter."
              }
              style={{ marginTop: 40 }}
            />
          ) : (
            visibleRows.map((row) => (
              <IdentityListItem
                key={row.segment.id}
                row={row}
                allowUpdate={allowUpdate}
                isActive={activeCellId === row.segment.id}
                onGoTo={handleGoTo}
                onConfirm={handleConfirm}
                onUnconfirm={handleResetDecision}
                onSearchName={handleSearchName}
                onContextMenu={onRowContextMenu}
              />
            ))
          )}
        </div>
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
          Confirmed IDs ({confirmedCount}/{allRows.length})
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
      </div>
    </div>
  );
}
