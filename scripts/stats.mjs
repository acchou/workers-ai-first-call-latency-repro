export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p90: null };
  const mid = Math.floor(sorted.length / 2);
  return { n: sorted.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1] };
}

export function summarize(pairs) {
  const metrics = ['headersMs', 'firstChunkMs', 'firstTextMs', 'totalMs'];
  const summary = {};
  for (const path of ['binding', 'https']) {
    const results = pairs.flatMap(pair => pair[path].results).filter(valid);
    summary[path] = {};
    for (const [phase, select] of [['first', r => r.call === 1], ['subsequent', r => r.call > 1]]) {
      summary[path][phase] = Object.fromEntries(metrics.map(metric =>
        [metric, distribution(results.filter(select).map(r => r[metric]))]));
    }
  }
  summary.pairedFirstBindingMinusHttps = Object.fromEntries(metrics.map(metric => [metric,
    distribution(pairs.flatMap(pair => {
      const binding = pair.binding.results.find(r => r.call === 1);
      const https = pair.https.results.find(r => r.call === 1);
      return valid(binding) && valid(https) ? [binding[metric] - https[metric]] : [];
    }))
  ]));
  summary.failedOrCachedCalls = pairs.flatMap(pair => ['binding', 'https'].flatMap(path =>
    pair[path].results.filter(r => !valid(r)).map(r => ({ pair: pair.index, path, ...r }))));
  return summary;
}

function valid(result) {
  return result?.ok === true && Number.isFinite(result.firstTextMs) &&
    !/^hit$/i.test(result.trace?.['cf-aig-cache-status'] ?? '');
}
