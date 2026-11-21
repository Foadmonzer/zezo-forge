const baseUrl = new URL(process.env.ZEZO_PERF_BASE_URL || 'https://zezo-forge-fouad.netlify.app');
const concurrency = Math.max(1, Math.min(32, Number(process.env.ZEZO_PERF_CONCURRENCY) || 10));
const samplesPerPath = Math.max(5, Math.min(100, Number(process.env.ZEZO_PERF_SAMPLES_PER_PATH) || 20));
const paths = ['/', '/team', '/api/public', '/api/health', '/api/notifications?limit=8'];
const requests = paths.flatMap(path => Array.from({ length: samplesPerPath }, () => ({ path, url: new URL(path, baseUrl).toString() })));
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < requests.length) {
    const request = requests[cursor++];
    const startedAt = performance.now();
    let status = 0;
    let error = '';
    try {
      const response = await fetch(request.url, { signal: AbortSignal.timeout(20_000) });
      status = response.status;
      await response.arrayBuffer();
    } catch (caught) {
      status = -1;
      error = caught?.name || 'fetch_error';
    }
    results.push({ path: request.path, status, error, ms: performance.now() - startedAt });
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] || 0;
const report = paths.map(path => {
  const rows = results.filter(row => row.path === path);
  const timings = rows.map(row => row.ms).sort((a, b) => a - b);
  const statuses = Object.fromEntries([...new Set(rows.map(row => row.status))].sort((a, b) => a - b).map(status => [status, rows.filter(row => row.status === status).length]));
  return {
    path,
    samples: rows.length,
    statuses,
    p50_ms: Math.round(percentile(timings, 0.50)),
    p95_ms: Math.round(percentile(timings, 0.95)),
    max_ms: Math.round(Math.max(...timings)),
    transport_errors: rows.filter(row => row.status === -1).length
  };
});

console.log(JSON.stringify({ base: baseUrl.origin, concurrency, samples_per_path: samplesPerPath, expected_auth_boundary: '/api/notifications returns 401 without a session', results: report }, null, 2));

const unexpected = results.filter(row => row.status === -1 || (row.path !== '/api/notifications?limit=8' && row.status !== 200) || (row.path === '/api/notifications?limit=8' && row.status !== 401));
if (unexpected.length) process.exitCode = 1;
