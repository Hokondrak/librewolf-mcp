# Performance profiling

Two tools measure two different things. Use both.

## Benchmarks: in-process cost

```powershell
npm run benchmark
```

Vitest benchmarks isolate the work the bridge itself does — parsing upstream
snapshot text, assigning stable UIDs, filtering and rendering the compact tree,
computing deltas, and redacting results — from browser and IPC latency. They
need no browser and are safe to run anywhere.

Recorded on the reference machine (Windows 11 x64, Node `v24.14.0`), mean per
operation:

| Benchmark                                          | Mean     |
| -------------------------------------------------- | -------- |
| Parse a 100-element page                           | 0.27 ms  |
| Parse a 1000-element page                          | 2.34 ms  |
| Cold snapshot, 100 elements (first UID assignment) | 0.66 ms  |
| Cold snapshot, 1000 elements                       | 6.76 ms  |
| Warm snapshot, 100 elements (UIDs reused)          | 1.05 ms  |
| Warm snapshot, 1000 elements                       | 7.27 ms  |
| Interactive-only with element cap, 1000 elements   | 7.17 ms  |
| Delta against the previous snapshot                | 15.71 ms |
| Redact a 100-request network listing               | 1.18 ms  |
| Redact a JSON request body                         | 0.047 ms |

The cached-snapshot target is 200 ms end to end, so the bridge's own share of
it stays roughly two orders of magnitude below the budget even on a page ten
times larger than a normal one. Treat a regression here as a real one: these
numbers have no browser variance to hide behind.

## Profiling: end-to-end latency and memory

Run against a release build and a normal local page:

```powershell
npm run build
npm run profile:performance
```

The profiler starts the public MCP CLI over stdio, launches a dedicated
headless LibreWolf profile, exercises the public tools, and writes the complete
result to `.temp/performance/latest.json`. It measures cached tab listing,
cached compact snapshots, cold and steady-state fill/click acknowledgements, a
ten-operation single-boundary batch, and idle bridge memory. The action
threshold uses the median of five operations after one reported warm-up.

Memory includes the MCP server, the upstream adapter, and GeckoDriver while
deliberately excluding LibreWolf. The idle figure is the median of five samples
and the observed peak is retained. On Windows the profiler reports hidden
`conhost.exe` console infrastructure separately: the acceptance figure is
application RSS, and the full descendant RSS remains in the evidence file for
transparency.

Two recorded runs against LibreWolf `146.0-2` on the same machine:

| Measurement                         | Target   | Run A     | Run B     | Verdict               |
| ----------------------------------- | -------- | --------- | --------- | --------------------- |
| Cached tab listing                  | <100 ms  | 12.5 ms   | 19.2 ms   | met                   |
| Cached compact snapshot             | <200 ms  | 16.0 ms   | 13.8 ms   | met                   |
| Fill acknowledgement (median of 5)  | <150 ms  | 93.3 ms   | 94.5 ms   | met                   |
| Click acknowledgement (median of 5) | <150 ms  | 138.0 ms  | 129.3 ms  | met, close to ceiling |
| Batch transport overhead            | <100 ms  | 1.7 ms    | 1.6 ms    | met                   |
| Bridge application RSS (median)     | <150 MiB | 141 MiB   | 177.2 MiB | **not met**           |
| Bridge application RSS (peak)       | —        | 169.3 MiB | 177.2 MiB | —                     |

**The memory target is not reliably met, and this is a known open issue.** Run B
exceeded it outright and the profiler exited nonzero. The sampling window opens
500 ms after the last operation and spans one second, so it measures memory
immediately after a workload rather than after a long idle: Run B's five samples
were 177.2, 177.2, 177.2, 163.5, and 145 MiB, still trending down when sampling
ended.

The measurement has deliberately not been relaxed to make the number pass.
Either the bridge's post-workload footprint needs reducing or the target needs
restating as a settled-idle figure with a defined settling period; until one of
those happens, treat 150 MiB as unmet. Latency targets are met with margin
everywhere except click acknowledgement, which sits close to its ceiling.

The result is machine-specific evidence, not a permanent compatibility
guarantee. Close unrelated heavy workloads, run it several times, and retain
the raw JSON when comparing releases. A failed threshold exits nonzero.

Local latency telemetry is also available from the controlled session and is
kept in memory only. It stores operation names, counts, durations, and error
counts; it does not store page content, form values, URLs, headers, or
screenshots.

The implementation bounds snapshot history, snapshot size, captured stderr,
and console/network query limits. Use the full test suite to preserve those
limits:

```powershell
npm test
```
