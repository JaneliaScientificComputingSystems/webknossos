import { DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Checkbox, Divider, Input, Tag, Tooltip, Typography, Upload } from "antd";
import type { UploadChangeParam, UploadFile } from "antd/lib/upload";
import { readFileAsText } from "libs/read_file";
import Toast from "libs/toast";
import { useState } from "react";
import {
  countDistinctNeurons,
  parseContactProfile,
} from "viewer/view/right_border_tabs/predictions_tab/contact_profile";
import { parseOfflinePredictions } from "viewer/view/right_border_tabs/predictions_tab/offline_predictions";
import { usePredictionConfiguration } from "viewer/view/right_border_tabs/predictions_tab/prediction_configuration_context";

const { Text } = Typography;

export default function PredictionsView() {
  const {
    allowUpdate,
    ignoredNames,
    setIgnoredNames,
    contactEdges,
    contactFileName,
    contactUploadedAt,
    setContactProfile,
    clearContactProfile,
    referenceDatasets,
    referenceDatasetsStatus,
    selectedReferenceDatasets,
    toggleReferenceDataset,
    writeMergedCandidates,
  } = usePredictionConfiguration();

  const [newIgnoredName, setNewIgnoredName] = useState("");

  const handleContactFileChange = async (info: UploadChangeParam<UploadFile<any>>) => {
    const file = info.fileList[info.fileList.length - 1]?.originFileObj;
    if (file == null) {
      return;
    }
    try {
      const contents = await readFileAsText(file);
      const { edges, skippedRowCount } = parseContactProfile(contents);
      if (edges.length === 0) {
        Toast.error("No valid contact rows found in this file.");
        return;
      }
      setContactProfile(edges, file.name);
      if (skippedRowCount > 0) {
        Toast.info(`Skipped ${skippedRowCount} row(s) that didn't fit the expected format.`);
      }
    } catch (exception) {
      Toast.error(
        exception instanceof Error ? exception.message : "Could not read the contact profile file.",
      );
    }
  };

  const [isUploadingOfflinePredictions, setIsUploadingOfflinePredictions] = useState(false);

  const handleOfflinePredictionsUpload = async (info: UploadChangeParam<UploadFile<any>>) => {
    const file = info.fileList[info.fileList.length - 1]?.originFileObj;
    if (file == null) {
      return;
    }
    setIsUploadingOfflinePredictions(true);
    try {
      const contents = await readFileAsText(file);
      const { predictions, isSeeds, skippedRowCount } = parseOfflinePredictions(contents);
      if (predictions.length === 0) {
        Toast.error("No valid rows found in this file.");
        return;
      }
      // Use the filename without its extension as the solution/source name
      // (e.g. "morphology_scores.csv" -> "morphology_scores") — shorter and
      // more readable than the full filename wherever the source shows up
      // (candidate tooltips, the per-source row label, raw metadata keys).
      const sourceName = file.name.replace(/\.[^./]+$/, "");
      const { written, createdCount, positionedCount, confirmedCount, skippedConfirmCount } =
        await writeMergedCandidates(sourceName, predictions, { autoConfirm: isSeeds });
      if (skippedRowCount > 0) {
        Toast.info(`Skipped ${skippedRowCount} row(s) that didn't fit the expected format.`);
      }
      const createdPart =
        createdCount > 0 ? `, ${createdCount} newly added to the segment list` : "";
      const positionedPart = createdCount > 0 ? `, ${positionedCount} with a known position` : "";
      if (isSeeds) {
        const skippedPart =
          skippedConfirmCount > 0
            ? ` (${skippedConfirmCount} left unconfirmed due to a conflicting name — sort by confidence to review)`
            : "";
        Toast.success(
          `Wrote seeds to ${written} segment(s), confirmed ${confirmedCount}${skippedPart}${createdPart}${positionedPart}.`,
        );
      } else {
        Toast.success(
          `Wrote offline predictions to ${written} segment(s)${createdPart}${positionedPart}.`,
        );
      }
    } catch (exception) {
      Toast.error(
        exception instanceof Error ? exception.message : "Could not upload offline predictions.",
      );
    } finally {
      setIsUploadingOfflinePredictions(false);
    }
  };

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto" }}>
      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Contact profile
      </Text>
      <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Upload a CSV/TSV file of segment contacts to use for ID prediction. Must have a header row
        with "neuron1", "neuron2" (segment IDs), and "contact_strength" columns.
      </Text>
      <Upload
        name="contactProfile"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        showUploadList={false}
        beforeUpload={() => false}
        onChange={handleContactFileChange}
        maxCount={1}
      >
        <Button icon={<UploadOutlined />}>Upload new contact profile</Button>
      </Upload>
      {contactFileName != null && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <Text style={{ flex: 1 }} ellipsis>
              {contactFileName}
              {contactUploadedAt != null &&
                ` (uploaded ${new Date(contactUploadedAt).toLocaleDateString()})`}
            </Text>
            <Tooltip title="Clear contact profile">
              <Button size="small" icon={<DeleteOutlined />} onClick={clearContactProfile} />
            </Tooltip>
          </div>
          <Text style={{ display: "block", fontSize: 12 }}>
            {contactEdges.length} contact(s) across {countDistinctNeurons(contactEdges)} neuron(s)
          </Text>
        </>
      )}

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Reference datasets
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Developmental-stage contactomes to match against, fetched from the prediction service. Run
        prediction runs once per checked dataset.
      </Text>
      {referenceDatasetsStatus === "loading" && (
        <Text style={{ display: "block", fontSize: 12, marginBottom: 8 }}>Loading datasets…</Text>
      )}
      {referenceDatasetsStatus === "failed" && (
        <Text type="danger" style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
          Could not load datasets.
        </Text>
      )}
      {referenceDatasetsStatus === "loaded" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginBottom: 8 }}>
          {referenceDatasets.map((dataset) => (
            <Checkbox
              key={dataset}
              checked={selectedReferenceDatasets.has(dataset)}
              onChange={(event) => toggleReferenceDataset(dataset, event.target.checked)}
            >
              {dataset}
            </Checkbox>
          ))}
        </div>
      )}

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Ignored names
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Excluded from the reference dataset for live Run matching, and from autocomplete suggestions
        elsewhere.
      </Text>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Input
          size="small"
          value={newIgnoredName}
          onChange={(event) => setNewIgnoredName(event.currentTarget.value)}
          onPressEnter={() => {
            const trimmed = newIgnoredName.trim();
            if (trimmed.length > 0 && !ignoredNames.includes(trimmed)) {
              setIgnoredNames([...ignoredNames, trimmed]);
            }
            setNewIgnoredName("");
          }}
          placeholder="Neuron name…"
          style={{ flex: 1 }}
        />
        <Button
          size="small"
          onClick={() => {
            const trimmed = newIgnoredName.trim();
            if (trimmed.length > 0 && !ignoredNames.includes(trimmed)) {
              setIgnoredNames([...ignoredNames, trimmed]);
            }
            setNewIgnoredName("");
          }}
        >
          Add
        </Button>
      </div>
      {ignoredNames.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
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

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Upload Offline Predictions
      </Text>
      <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Upload a CSV with "seg" (segment ID) and "neuron" (a neuron name) columns. Filename is used
        as the prediction source name.
        <br />
        With a "score" column: candidate scores, written for proofreading like a live Run. Ideally
        in confidence percentage space so they can be averaged with other confidence scores.
        <br />
        Without a "score" column: ground-truth seeds — written at 100% and auto-confirmed, skipping
        any row whose name conflicts with an existing confirmation elsewhere.
      </Text>
      <Upload
        name="offlinePredictions"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        showUploadList={false}
        beforeUpload={() => false}
        onChange={handleOfflinePredictionsUpload}
        maxCount={1}
        disabled={!allowUpdate || isUploadingOfflinePredictions}
      >
        <Button icon={<UploadOutlined />} loading={isUploadingOfflinePredictions}>
          Upload offline predictions or seeds CSV…
        </Button>
      </Upload>
    </div>
  );
}
