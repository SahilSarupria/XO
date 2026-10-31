# CPU-only benchmark

`node scripts/bench-cpu.mjs [--tasks 2000] [--sizes 120,500,1000,2000] [--json out.json]` (after `npm run build`).
No model, no network, no API key — it exercises only the layer: load + verification, retrieval, local decision-tree solves
(the "no model call" path) and the safety gate, over the Halvorsen package at several knowledge-base sizes. The script fails if its
decision-tree input does not actually solve, so it cannot silently time an error path.

## Result (one run, 1,000 iterations per measure)

Machine: Intel Xeon @ 2.10 GHz × 2 cores, 8 GB RAM, linux x64, Node v22.23.4 (a shared cloud sandbox — treat as a rough floor, not a tuned server).
Latencies are wall-clock milliseconds; "/s" is single-thread throughput.

| KB nodes | load  | retrieve p50 / p95 (per s) | decision tree p50 / p95 (per s) | safety gate p50 / p95 (per s) |
| -------- | ----- | -------------------------- | ------------------------------- | ----------------------------- |
| 141      | 8 ms  | 0.66 / 0.94 ms (1,490)     | 0.009 / 0.020 ms (≈80,000)      | 0.004 / 0.007 ms (≈125,000)   |
| 521      | 11 ms | 2.06 / 2.94 ms (481)       | 0.009 / 0.020 ms (≈78,000)      | 0.002 / 0.003 ms              |
| 1,021    | 21 ms | 3.5 / 4.5 ms (268)         | 0.009 / 0.020 ms (≈84,000)      | 0.002 / 0.002 ms              |
| 2,021    | 45 ms | 7.5 / 10.1 ms (128)        | 0.009 / 0.020 ms (≈81,000)      | 0.002 / 0.002 ms              |

Peak resident memory of the whole process: ~133 MB.

## What this does and does not show

- Shows: the layer's own work is small — retrieval grows roughly linearly with knowledge size (about 3.7 µs per node per query here) and stays
  in single-digit milliseconds at 2,000 nodes; a local solve is tens of microseconds. None of it needs a GPU or a network.
- Does not show: accuracy at those sizes (the 1,000+ node KB here is the scenario's handbook filler, so retrieval _quality_ at scale is not measured by
  this script), model latency, or multi-core scaling (single thread only).
- Numbers are from one machine and one run; re-run on your hardware before quoting them.
