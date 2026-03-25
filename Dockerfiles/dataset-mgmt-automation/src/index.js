import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import logger from './logger.js';
import {
  readDataset,
  createDataset,
  updateDataset,
  transitionStatus,
  publishDataset,
} from './api.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATASETS_DIR = resolve(__dirname, '..', 'datasets');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3005';

const loadJson = async (filePath) => {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
};

/**
 * Discover all dataset IDs by listing sub-folders in the datasets/ directory.
 */
const discoverDatasets = async () => {
  const entries = await readdir(DATASETS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
};

/**
 * Load schema.json and config.json for a given dataset.
 */
const loadDatasetFiles = async (datasetId) => {
  const dir = join(DATASETS_DIR, datasetId);
  const schemaPath = join(dir, 'schema.json');
  const configPath = join(dir, 'config.json');

  if (!existsSync(schemaPath)) throw new Error(`Missing schema.json for dataset "${datasetId}"`);
  if (!existsSync(configPath)) throw new Error(`Missing config.json for dataset "${datasetId}"`);

  const [dataSchema, datasetConfig] = await Promise.all([
    loadJson(schemaPath),
    loadJson(configPath),
  ]);
  return { dataSchema, datasetConfig };
};

/**
 * Extract version_key from the Read API response.
 */
const extractVersionKey = (readResponse) => {
  // Response structure: { result: { dataset: { version_key: "..." } } }
  return readResponse?.result?.dataset?.version_key
    ?? readResponse?.result?.version_key
    ?? readResponse?.version_key;
};

/**
 * Run the Create flow: Create → ReadyToPublish → Live
 */
const runCreateFlow = async (datasetId, dataSchema, datasetConfig) => {
  logger.info(`[${datasetId}] Running CREATE flow.`);
  await createDataset(BASE_URL, datasetId, dataSchema, datasetConfig);
  await transitionStatus(BASE_URL, datasetId, 'ReadyToPublish');
  await publishDataset(BASE_URL, datasetId);
  logger.info(`[${datasetId}] CREATE flow completed.`);
};

/**
 * Run the Update flow: Update → ReadyToPublish → Live
 */
const runUpdateFlow = async (datasetId, versionKey, dataSchema, datasetConfig) => {
  logger.info(`[${datasetId}] Running UPDATE flow.`);
  await updateDataset(BASE_URL, datasetId, versionKey, dataSchema, datasetConfig);
  await transitionStatus(BASE_URL, datasetId, 'ReadyToPublish');
  await publishDataset(BASE_URL, datasetId);
  logger.info(`[${datasetId}] UPDATE flow completed.`);
};

/**
 * Process a single dataset — auto-detect create vs update.
 */
const processDataset = async (datasetId) => {
  logger.info(`[${datasetId}] Starting processing...`);
  const { dataSchema, datasetConfig } = await loadDatasetFiles(datasetId);

  let readResponse;
  try {
    readResponse = await readDataset(BASE_URL, datasetId);
  } catch (err) {
    if (err.status === 404) {
      logger.info(`[${datasetId}] Dataset not found. Switching to CREATE flow.`);
      await runCreateFlow(datasetId, dataSchema, datasetConfig);
      return;
    }
    throw err;
  }

  const versionKey = extractVersionKey(readResponse);
  if (!versionKey) {
    throw new Error(`[${datasetId}] Could not extract version_key from Read response.`);
  }
  await runUpdateFlow(datasetId, versionKey, dataSchema, datasetConfig);
};

/**
 * Main entry point.
 */
const main = async () => {
  logger.info('Dataset Management Job starting...');
  logger.info(`BASE_URL: ${BASE_URL}`);
  logger.info(`Datasets directory: ${DATASETS_DIR}`);

  const datasetIds = await discoverDatasets();
  if (datasetIds.length === 0) {
    logger.warn('No dataset folders found. Exiting.');
    process.exit(0);
  }

  logger.info(`Discovered datasets: ${datasetIds.join(', ')}`);

  let hasFailure = false;
  for (const datasetId of datasetIds) {
    try {
      await processDataset(datasetId);
    } catch (err) {
      logger.error(`[${datasetId}] Processing failed: ${err.message}`);
      if (err.body) logger.error(`[${datasetId}] Response body:`, JSON.stringify(err.body));
      hasFailure = true;
    }
  }

  if (hasFailure) {
    logger.error('One or more datasets failed to process.');
    process.exit(1);
  }

  logger.info('All datasets processed successfully.');
};

main();
