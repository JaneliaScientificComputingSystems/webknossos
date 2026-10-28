import { DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import {
  Button,
  Checkbox,
  Divider,
  Input,
  InputNumber,
  Radio,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { UploadChangeParam, UploadFile } from "antd/es/upload";
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
    predictionMode,
    setPredictionMode,
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
    selectedEmbryo,
    setSelectedEmbryo,
    selectedTimepoint,
    setSelectedTimepoint,
    nTrials,
    setNTrials,
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
      const { written, confirmedCount, skippedConfirmCount, skippedMissingTreeCount } =
        writeMergedCandidates(sourceName, predictions, { autoConfirm: isSeeds });
      if (skippedRowCount > 0) {
        Toast.info(`Skipped ${skippedRowCount} row(s) that didn't fit the expected format.`);
      }
      const missingPart =
        skippedMissingTreeCount > 0
          ? ` (${skippedMissingTreeCount} skipped — no matching tree)`
          : "";
      if (isSeeds) {
        const skippedPart =
          skippedConfirmCount > 0
            ? ` (${skippedConfirmCount} left unconfirmed due to a conflicting name — sort by confidence to review)`
            : "";
        Toast.success(
          `Wrote seeds to ${written} tree(s), confirmed ${confirmedCount}${skippedPart}${missingPart}.`,
        );
      } else {
        Toast.success(`Wrote offline predictions to ${written} tree(s)${missingPart}.`);
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
        Prediction method
      </Text>
      <Radio.Group
        value={predictionMode}
        onChange={(event) => setPredictionMode(event.target.value)}
        style={{ marginBottom: 8 }}
      >
        <Radio.Button value="contactome">Contactome</Radio.Button>
        <Radio.Button value="nuclear">Nuclear position</Radio.Button>
      </Radio.Group>

      <Divider style={{ margin: "12px 0" }} />

      {predictionMode === "contactome" && (
        <>
          <Text strong style={{ display: "block", marginBottom: 4 }}>
            Contact profile
          </Text>
          <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            Upload a CSV/TSV file of tree contacts to use for ID prediction. Must have a header row
            with "neuron1", "neuron2" (tree IDs), and "contact_strength" columns.
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
                {contactEdges.length} contact(s) across {countDistinctNeurons(contactEdges)} tree(s)
              </Text>
            </>
          )}

          <Divider style={{ margin: "12px 0" }} />

          <Text strong style={{ display: "block", marginBottom: 4 }}>
            Reference datasets
          </Text>
          <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            Developmental-stage contactomes to match against, fetched from the prediction service.
            Run prediction runs once per checked dataset.
          </Text>
          {referenceDatasetsStatus === "loading" && (
            <Text style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
              Loading datasets…
            </Text>
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
        </>
      )}

      {predictionMode === "nuclear" && (
        <>
          <Text strong style={{ display: "block", marginBottom: 4 }}>
            Reference atlas
          </Text>
          <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            Embryo and timepoint to match against — must already be registered on the nuclear
            prediction service. Positions are read directly from each tree's node; no file upload
            needed.
          </Text>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <Text style={{ fontSize: 12, flex: "0 0 auto" }}>Embryo:</Text>
            <Input
              size="small"
              value={selectedEmbryo ?? ""}
              onChange={(event) => setSelectedEmbryo(event.target.value || null)}
              placeholder="e.g. embryo1"
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <Text style={{ fontSize: 12, flex: "0 0 auto" }}>Timepoint:</Text>
            <InputNumber
              size="small"
              value={selectedTimepoint}
              onChange={(value) => setSelectedTimepoint(typeof value === "number" ? value : null)}
              placeholder="e.g. 120"
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <Tooltip title="Number of perturbed matching trials to ensemble into each tree's confidence score.">
              <Text style={{ fontSize: 12, flex: "0 0 auto" }}>Trials:</Text>
            </Tooltip>
            <InputNumber
              size="small"
              min={1}
              value={nTrials}
              onChange={(value) => setNTrials(typeof value === "number" ? value : 20)}
              style={{ flex: 1 }}
            />
          </div>
        </>
      )}

      <Divider style={{ margin: "12px 0" }} />

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
        Upload a CSV with "seg" (tree ID) and "neuron" (a neuron name) columns. Filename is used as
        the prediction source name.
        <br />
        With a "score" column: candidate scores, written for proofreading like a live Run. Ideally
        in confidence percentage space so they can be averaged with other confidence scores.
        <br />
        Without a "score" column: ground-truth seeds — written at 100% and auto-confirmed, skipping
        any row whose name conflicts with an existing confirmation elsewhere. Rows referencing a
        tree ID that doesn't exist yet are skipped (this panel never creates trees).
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
