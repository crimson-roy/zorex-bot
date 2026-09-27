'use strict';

const COBALT_URL = process.env.COBALT_URL || 'http://127.0.0.1:9000/';

function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Please provide a valid http(s) media URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) media URLs are supported.');
  }

  return parsed.toString();
}

async function resolveMedia(url) {
  const targetUrl = assertHttpUrl(url);

  const response = await fetch(COBALT_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: targetUrl,
      downloadMode: 'auto',
      videoQuality: '720',
      youtubeVideoContainer: 'mp4',
      filenameStyle: 'pretty',
      localProcessing: 'disabled',
    }),
    signal: AbortSignal.timeout(45000),
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Cobalt returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok || data.status === 'error') {
    const code = data?.error?.code || `HTTP ${response.status}`;
    const err = new Error(`Cobalt media error: ${code}`);
    err.code = code;
    err.context = data?.error?.context;
    throw err;
  }

  return data;
}

module.exports = {
  COBALT_URL,
  resolveMedia,
};
