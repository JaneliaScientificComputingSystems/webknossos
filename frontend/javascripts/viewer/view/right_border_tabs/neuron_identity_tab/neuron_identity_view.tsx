import { AimOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import {
  Button,
  Empty,
  type MenuProps,
  Segmented,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ChangeColorMenuItemContent } from "components/color_picker";
import { useWkSelector } from "libs/react_hooks";
import Toast from "libs/toast";
import { type MouseEvent, useMemo, useState } from "react";
import { useDispatch } from "react-redux";
import type { Vector3 } from "viewer/constants";
import { mayEditAnnotation } from "viewer/model/accessors/annotation_accessor";
import { getVisibleSegmentationLayer } from "viewer/model/accessors/dataset_accessor";
import { layerToGlobalTransformedPosition } from "viewer/model/accessors/dataset_layer_transformation_accessor";
import {
  getSegmentColorAsRGBA,
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
import { InputWithUpdateOnBlur } from "viewer/view/components/input_with_update_on_blur";
import { getContextMenuPositionFromEvent } from "viewer/view/context_menu/helpers";
import PredictionsView from "viewer/view/right_border_tabs/predictions_tab/predictions_view";
import { ContextMenuContainer } from "viewer/view/right_border_tabs/sidebar_context_menu";
import {
  bestScore,
  type CandidateScores,
  getIdentityStatus,
  getSegmentIdentity,
  type IdentityStatus,
  type SegmentIdentity,
  withConfirmedIdentity,
  withRejectedName,
  withUnconfirmedIdentity,
  withUnrejectedName,
} from "./neuron_identity_metadata";

const CONTEXT_MENU_OVERLAY_CLASS = "neuron-identity-context-menu-overlay";

const { Text } = Typography;

type FilterKey = "all" | "review" | "confirmed" | "rejected";
type SortKey = "confidence" | "id" | "name";

type IdentityRow = {
  segment: Segment;
  identity: SegmentIdentity;
  status: IdentityStatus;
};

const STATUS_TAG_COLOR: Record<IdentityStatus, string | undefined> = {
  predicted: "blue",
  confirmed: "green",
  rejected: "red",
  none: undefined,
};

const STATUS_LABEL: Record<IdentityStatus, string> = {
  predicted: "predicted",
  confirmed: "confirmed",
  rejected: "rejected",
  none: "unlabeled",
};

function formatScore(score: number): string {
  return Number.isFinite(score) ? `${Math.round(score * 100)}%` : "–";
}

function formatSourceScores(candidate: CandidateScores): string {
  return Object.entries(candidate.scoresBySource)
    .map(([source, score]) => `${source}: ${formatScore(score)}`)
    .join(", ");
}

function matchesFilter(status: IdentityStatus, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review":
      return status === "predicted";
    case "confirmed":
      return status === "confirmed";
    case "rejected":
      return status === "rejected";
  }
}

function topLiveCandidate(identity: SegmentIdentity): CandidateScores | undefined {
  return identity.candidates
    .filter((candidate) => !identity.rejectedNames.includes(candidate.name))
    .sort((a, b) => bestScore(b) - bestScore(a))[0];
}

function IdentityListItem({
  row,
  allowUpdate,
  isActive,
  onGoTo,
  onConfirm,
  onReject,
  onUnreject,
  onContextMenu,
}: {
  row: IdentityRow;
  allowUpdate: boolean;
  isActive: boolean;
  onGoTo: (segment: Segment) => void;
  onConfirm: (segment: Segment, name: string) => void;
  onReject: (segment: Segment, name: string) => void;
  onUnreject: (segment: Segment, name: string) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, row: IdentityRow) => void;
}) {
  const { segment, identity, status } = row;
  const segmentColorRGBA = useWkSelector((state) => getSegmentColorAsRGBA(state, segment.id));
  const displayName = identity.confirmed ?? segment.name ?? null;
  const topCandidate = topLiveCandidate(identity);
  const sortedCandidates = [...identity.candidates].sort((a, b) => bestScore(b) - bestScore(a));

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
        <Text type="secondary" style={{ fontVariantNumeric: "tabular-nums" }}>
          #{segment.id}
        </Text>
        {allowUpdate ? (
          <InputWithUpdateOnBlur
            value={displayName ?? ""}
            onChange={(newName) => {
              const trimmed = newName.trim();
              if (trimmed.length > 0) {
                onConfirm(segment, trimmed);
              }
            }}
            size="small"
            placeholder="Assign name…"
            style={{ flex: 1 }}
          />
        ) : (
          <Text strong ellipsis style={{ flex: 1 }}>
            {displayName ?? <Text type="secondary">unnamed</Text>}
          </Text>
        )}
        <Tag color={STATUS_TAG_COLOR[status]} style={{ marginInlineEnd: 0 }}>
          {STATUS_LABEL[status]}
        </Tag>
      </div>

      {sortedCandidates.length > 0 && (
        <div style={{ margin: "6px 0 4px 20px", display: "flex", flexWrap: "wrap", gap: 4 }}>
          {sortedCandidates.map((candidate) => {
            const isConfirmed = identity.confirmed === candidate.name;
            const isRejected = identity.rejectedNames.includes(candidate.name);
            return (
              <Tooltip
                key={candidate.name}
                title={
                  allowUpdate
                    ? isConfirmed
                      ? "Selected identity"
                      : isRejected
                        ? "Rejected — click to reconsider"
                        : `Scores — ${formatSourceScores(candidate)}`
                    : formatSourceScores(candidate)
                }
              >
                <Tag
                  color={isConfirmed ? "green" : isRejected ? "default" : undefined}
                  icon={isConfirmed ? <CheckOutlined /> : undefined}
                  style={{
                    cursor: allowUpdate ? "pointer" : "default",
                    marginInlineEnd: 0,
                    ...(isRejected && { textDecoration: "line-through", opacity: 0.6 }),
                    ...(isConfirmed && {
                      fontWeight: 600,
                      // Simulate a "pressed" button look for the chosen identity.
                      boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.3)",
                    }),
                  }}
                  onClick={
                    allowUpdate
                      ? () =>
                          isRejected
                            ? onUnreject(segment, candidate.name)
                            : onConfirm(segment, candidate.name)
                      : undefined
                  }
                >
                  {candidate.name} {formatScore(bestScore(candidate))}
                </Tag>
              </Tooltip>
            );
          })}
        </div>
      )}

      {allowUpdate && sortedCandidates.length > 0 && (
        <div style={{ marginLeft: 20, marginTop: 4 }}>
          <Space size={4} wrap>
            {topCandidate != null && identity.confirmed !== topCandidate.name && (
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => onConfirm(segment, topCandidate.name)}
              >
                Accept {topCandidate.name}
              </Button>
            )}
            {topCandidate != null && (
              <Button
                size="small"
                icon={<CloseOutlined />}
                onClick={() => onReject(segment, topCandidate.name)}
              >
                Reject {topCandidate.name}
              </Button>
            )}
          </Space>
        </div>
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
  const [subTab, setSubTab] = useState<"proofread" | "predictions">("proofread");

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
        const nameA = a.identity.confirmed ?? a.segment.name ?? "";
        const nameB = b.identity.confirmed ?? b.segment.name ?? "";
        return nameA.localeCompare(nameB);
      }
      // "confidence"
      const topA = topLiveCandidate(a.identity);
      const topB = topLiveCandidate(b.identity);
      return (topB != null ? bestScore(topB) : Number.NEGATIVE_INFINITY) -
        (topA != null ? bestScore(topA) : Number.NEGATIVE_INFINITY);
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

  const handleReject = (segment: Segment, name: string) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        { metadata: withRejectedName(segment.metadata ?? [], name) },
        visibleSegmentationLayer.name,
        undefined,
        true,
      ),
    );
  };

  const handleUnreject = (segment: Segment, name: string) => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatch(
      updateSegmentAction(
        segment.id,
        { metadata: withUnrejectedName(segment.metadata ?? [], name) },
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
        items.push({
          key: "confirmCandidate",
          label: "Confirm identity",
          children: identity.candidates.map((candidate) => ({
            key: `confirm-${candidate.name}`,
            label: `${candidate.name} ${formatScore(bestScore(candidate))}`,
            onClick: withHide(() => handleConfirm(segment, candidate.name)),
          })),
        });
        items.push({
          key: "rejectCandidate",
          label: "Reject name",
          children: identity.candidates.map((candidate) => {
            const isRejected = identity.rejectedNames.includes(candidate.name);
            return {
              key: `reject-${candidate.name}`,
              label: isRejected
                ? `${candidate.name} (rejected — click to reconsider)`
                : candidate.name,
              onClick: withHide(() =>
                isRejected
                  ? handleUnreject(segment, candidate.name)
                  : handleReject(segment, candidate.name),
              ),
            };
          }),
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
      <Tabs
        activeKey={subTab}
        onChange={(key) => setSubTab(key as "proofread" | "predictions")}
        size="small"
        tabBarStyle={{ paddingInline: 8, marginBottom: 0 }}
        items={[
          { key: "proofread", label: "Proofreading" },
          { key: "predictions", label: "Predictions" },
        ]}
      />

      {/*
        Both sub-tabs stay mounted (toggled via `display`) rather than being
        conditionally rendered, so panel-local state — e.g. the Predictions
        tab's in-memory contact profile — survives switching sub-tabs.
      */}
      <div
        style={{ flex: 1, minHeight: 0, display: subTab === "predictions" ? undefined : "none" }}
      >
        <PredictionsView />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: subTab === "predictions" ? "none" : "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: 8,
            borderBottom: "1px solid var(--color-wk-border, rgba(128,128,128,0.2))",
          }}
        >
          <Text type="secondary" style={{ display: "block" }}>
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
                { label: "Rejected", value: "rejected" },
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
                onReject={handleReject}
                onUnreject={handleUnreject}
                onContextMenu={onRowContextMenu}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
