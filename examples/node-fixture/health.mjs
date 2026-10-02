try {
  const r = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(1500) });
  const v = await r.json();
  if (!r.ok || v.fixture !== true || v.version !== process.env.FIXTURE_VERSION || !/^[a-f0-9]{64}$/.test(v.marker)) process.exit(1);
  // Fixed non-secret receipt; executor never returns raw container logs.
  console.log(JSON.stringify({ fixture: true, version: v.version, marker: v.marker }));
} catch { process.exit(1); }
