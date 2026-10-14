---
name: drivebay
description: Read and write files on a Drivebay PC with a bearer token. Writes wait for approval on that PC.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node"], "env": ["DRIVEBAY_URL", "DRIVEBAY_TOKEN"] },
        "primaryEnv": "DRIVEBAY_TOKEN",
      },
  }
---

# Drivebay

Use this skill to list, read, and change files on the PC that runs Drivebay.

## Setup

The PC creates the token on its settings page and shows it once. Set these for the skill:

- `DRIVEBAY_URL` — the Drivebay address, such as `http://100.x.y.z:42013`
- `DRIVEBAY_TOKEN` — the token from that PC. It starts with `db_`

This folder needs Node.js. It does not install packages. The script's only network call is to `DRIVEBAY_URL`.

## Commands

From this folder:

```
node scripts/drivebay.js roots
node scripts/drivebay.js ls <path>
node scripts/drivebay.js stat <path>
node scripts/drivebay.js find <path> <query>
node scripts/drivebay.js get <path> [--out file]
node scripts/drivebay.js put <local> <remote>
node scripts/drivebay.js mkdir <path>
node scripts/drivebay.js mv <path> <new-name>
node scripts/drivebay.js rm <path>
```

`mkdir` creates one folder. The parent has to exist. `mv` renames inside the same folder.

Add `--yes` only after the user has agreed.

## Writes

`put`, `mkdir`, `mv`, and `rm` do nothing until the PC allows them. When Drivebay returns an approval id, tell the user this exact status and then wait:

Waiting for approval on Drivebay

Poll `GET /api/v1/approvals/<id>` until the status is approved, denied, or expired. After approval, retry that same action once. Do not tell the user the write finished before Drivebay accepts it. The poll interval is `DRIVEBAY_APPROVAL_POLL_MS` (default 2000).

## Safety

- Never overwrite a remote file, or a local download, unless the user agrees. If there is no terminal, stop unless `--yes` was passed.
- Before downloading a file larger than `DRIVEBAY_GET_CONFIRM_BYTES` (default 20 MB), ask. If there is no terminal, stop unless `--yes` was passed.
- Do not print the token.
- The script does not call ClawHub. Publish this folder from the repository root after `clawhub login`:

```
clawhub skill publish ./skills/drivebay --slug drivebay --name "Drivebay" --version 1.0.0
```

Do not include the token in that publish.
