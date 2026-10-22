import { parentPort, workerData } from "node:worker_threads";
import { analyzeDatasetChange } from "./import-dataset-analysis.js";
const data = workerData as { staging: string; previous: string; batchId: string; preserveAbsent?: boolean };
parentPort?.postMessage(analyzeDatasetChange(data.staging, data.previous, data.batchId, data.preserveAbsent));
