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
import { uploadOfflinePredictions } from "viewer/view/right_border_tabs/predictions_tab/prediction_client";
import { usePredictionConfiguration } from "viewer/view/right_border_tabs/predictions_tab/prediction_configuration_context";

const { Text } = Typography;

export default function PredictionsView() {
  const {
    allowUpdate,
    datasetId,
    ignoredNames,
    setIgnoredNames,
    contactEdges,
    contactFileName,
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
      const response = await uploadOfflinePredictions(datasetId, file);
      // Use the filename without its extension as the solution/source name
      // (e.g. "morphology_scores.csv" -> "morphology_scores") — shorter and
      // more readable than the full filename wherever the source shows up
      // (candidate tooltips, the per-source row label, raw metadata keys).
      const sourceName = file.name.replace(/\.[^./]+$/, "");
      const { written, createdCount, positionedCount } = await writeMergedCandidates(
        sourceName,
        response.predictions,
      );
      Toast.success(
        createdCount > 0
          ? `Wrote offline predictions to ${written} segment(s) (${createdCount} newly added to the segment list, ${positionedCount} with a known position).`
          : `Wrote offline predictions to ${written} segment(s).`,
      );
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

      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Run prediction{selectedReferenceDatasets.size > 1 ? "s" : ""} from the button above
        Confirmed IDs, once a contact profile and at least one reference dataset are ready.
      </Text>

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Upload Offline Predictions
      </Text>
      <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Upload a CSV with header rows "seg" (segment ID), "neuron" (a neuron name), and "score"
        columns. Filename will be used as prediction name. Ideally scores are in confidence
        percentage space to they can be averaged with other confidence scores.
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
          Upload offline predictions CSV…
        </Button>
      </Upload>
    </div>
  );
}
