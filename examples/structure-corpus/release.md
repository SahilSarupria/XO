# Release Runbook

## Release steps

| # | Step | What to do | Done when |
|---|------|------------|-----------|
| 1 | Freeze | Stop merging to main. Announce the freeze in the release channel. | No open merges |
| 2 | Build | Build the release candidate from the tagged commit. Attach the build log. | Candidate built |
| 3 | Verify | Run the smoke tests against staging. Check the error dashboards. | Smoke tests pass |
| 4 | Ship | Deploy the candidate to production and watch the error rate for one hour. | Error rate normal |

## Coverage of this runbook

If the release fails verification, then stop the release.
