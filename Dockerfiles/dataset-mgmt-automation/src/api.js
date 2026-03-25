import logger from './logger.js';

const buildEnvelope = (id, request) => ({
  id,
  ver: 'v2',
  ts: new Date().toISOString(),
  params: { msgid: crypto.randomUUID() },
  request,
});

const handleResponse = async (res, context) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${context} failed with status ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
};

/**
 * Read a dataset. Returns the parsed response body.
 * Throws an error with err.status === 404 if not found.
 */
export const readDataset = async (baseUrl, datasetId) => {
  const url = `${baseUrl}/v2/datasets/read/${encodeURIComponent(datasetId)}?mode=edit&fields=version_key`;
  logger.info(`[${datasetId}] Reading dataset...`);
  const res = await fetch(url);
  return handleResponse(res, `Read[${datasetId}]`);
};

/**
 * Create a new dataset.
 */
export const createDataset = async (baseUrl, datasetId, dataSchema, datasetConfig) => {
  const url = `${baseUrl}/v2/datasets/create`;
  logger.info(`[${datasetId}] Creating dataset...`);
  const body = buildEnvelope('api.datasets.create', {
    dataset_id: datasetId,
    type: 'event',
    name: datasetId,
    data_schema: dataSchema,
    dataset_config: datasetConfig,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, `Create[${datasetId}]`);
};

/**
 * Update an existing dataset.
 */
export const updateDataset = async (baseUrl, datasetId, versionKey, dataSchema, datasetConfig) => {
  const url = `${baseUrl}/v2/datasets/update`;
  logger.info(`[${datasetId}] Updating dataset (version_key=${versionKey})...`);
  const body = buildEnvelope('api.datasets.update', {
    dataset_id: datasetId,
    version_key: versionKey,
    data_schema: dataSchema,
    dataset_config: datasetConfig,
  });
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, `Update[${datasetId}]`);
};

/**
 * Transition dataset status (e.g. to "ReadyToPublish" or "Live").
 */
export const transitionStatus = async (baseUrl, datasetId, status) => {
  const url = `${baseUrl}/v2/datasets/status-transition`;
  logger.info(`[${datasetId}] Transitioning status to "${status}"...`);
  const body = buildEnvelope('api.datasets.status-transition', {
    dataset_id: datasetId,
    status,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, `StatusTransition[${datasetId}][${status}]`);
};

/**
 * Publish a dataset (transition to "Live"). Logs a warning on failure instead of throwing.
 */
export const publishDataset = async (baseUrl, datasetId) => {
  try {
    await transitionStatus(baseUrl, datasetId, 'Live');
    logger.info(`[${datasetId}] Published successfully.`);
  } catch (err) {
    logger.warn(`[${datasetId}] Publish call failed (this may still succeed internally): ${err.message}`);
  }
};
