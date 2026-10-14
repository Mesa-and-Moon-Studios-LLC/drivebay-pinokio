# Drivebay

Read and write files on the PC that runs Drivebay.

**Needs:** Node.js, `DRIVEBAY_URL`, and `DRIVEBAY_TOKEN`

**Script:** `skills/drivebay/scripts/drivebay.js`

**Commands:** roots, ls, stat, find, get, put, mkdir, mv, rm

The token is a bearer key for the folders allowed on that PC. It can list, stat, search, download, and fetch a thumbnail. A write waits until someone at the PC approves that one action, or opens a short write window. The script says `Waiting for approval on Drivebay` and polls. It talks only to `DRIVEBAY_URL`. It does not overwrite a file, and it does not download a large file, unless you agree.

Create and revoke tokens on the Drivebay PC. Do not publish this skill or a token to ClawHub.
