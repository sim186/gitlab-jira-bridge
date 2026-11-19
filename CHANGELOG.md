# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.5.2] — 2026-11-19

### Added

- **`approved` on GitLab versions without an approval webhook.** Current GitLab
  sends the approval as an ordinary merge-request event with
  `action: "approved"` (and `"unapproved"`), which the planner used to record as
  `action "approved" not mapped`. Approving now adds `labels.approved` and
  removes `needs-review`; unapproving removes it and puts `needs-review` back
  when reviewers are still assigned. The older dedicated
  `event_type: "approval"` shape keeps working. The missing-key note never fires
  on either shape.

## [0.5.1] — 2026-11-19

### Fixed

- **Reviewer changes were ignored on GitLab 16 and newer.** Those versions send
  the change as `changes.reviewers` (a list of users); the bridge only looked at
  `changes.reviewer` (a single user, the older shape), so assigning or removing a
  reviewer planned nothing and `reviewer-<name>` was never written. Both shapes
  are now read, `previousReviewers`/`currentReviewers` included.

## [0.5.0] — 2026-11-19

### Changed

- **Readable ticket comments.** The open and merge comments are now two lines,
  with an emoji (🔀 opened, ✅ merged), `branch` → `target` as inline
  code, and the merge request as a **link**. Jira does not auto-link text sent
  through its API, so URLs and `[label](url)` are converted to link marks in the
  comment's ADF; each line becomes its own paragraph.
- The missing-key MR comment starts with ⚠️ so it reads as a warning in the
  MR timeline.

## [0.4.0] — 2026-11-19

### Added

- **`jira.other_project_keys`**: name the Jira projects you do not act on
  (`[XYZ, DEF]`). An MR whose only key belongs to one of them is **foreign**:
  no labels, no comment, and — unlike a missing key — never the "not linked
  to Jira" comment, because it is linked elsewhere. The audit trail records
  `foreign: title names XYZ-7 (not a tracked Jira project)`. Matched in any
  case, in both `project_keys` and `key_regex` mode.

## [0.3.0] — 2026-11-19

### Added

- **Comment on MRs that cannot be linked to Jira** (opt-in,
  `behaviours.comment_on_missing_key`). One comment per MR, on open, reopen or
  a title/description edit, saying why (no key, or which keys conflict) and
  how to fix it. Skips `missing_key.skip_authors` and `skip_branches`.
  Needs `gitlab.token` (bot user, `api` scope, Reporter); this is the bridge's
  only GitLab write.
- **`jira.project_keys`**: list your Jira projects to match keys in any case
  (`feature/abc-123-login` → ABC-123), limited to those projects.
- An edit that links an MR to a ticket (key added, ambiguous title narrowed,
  or a different ticket named) now does for that ticket what opening the MR
  would have: branch comment and review-request labels.
- `key_regex` and `key_ignore_regex` are validated at startup.

### Changed

- **The title now wins.** The title, branch and description are checked in
  that order and the first naming exactly one key is used. Before, keys from
  all three were pooled, so an MR whose description mentioned a related
  ticket was skipped as ambiguous.
- **Labels are changed with Jira's add/remove operations** instead of
  rewriting the whole label list, so a hand edit made while the bridge is
  working is no longer overwritten. Empty (disabled) label names are dropped
  instead of being sent to Jira.
- **Jira comments are tagged with their action id** (an invisible comment
  property) and checked before posting, so a crash right after posting, a
  lost `state.json` or an id past the 50k cap cannot duplicate a comment.
- Open-action ids now include the ticket key (`900:ABC-1:open-comment`), so
  each ticket an MR is pointed at gets its open actions once.

### Fixed

- The README suggested `(?i)…` as a case-insensitive `key_regex`. JavaScript
  does not support inline flags, so the bridge could not start with it, and
  lowercase matches were discarded anyway. `project_keys` replaces it.

## [0.2.0] — 2026-11-19

### Added

- **Retry queue.** The webhook now queues the planned actions on disk and
  answers 200 at once; a background worker applies them to Jira. Transient
  failures (5xx, 429, network) are retried with exponential backoff (`retry:`
  in the config) and recorded as `abandoned` once `max_attempts` is reached.
  Order is kept per ticket, and the queue survives restarts.
- **`bridge replay`** re-queues actions whose latest outcome is
  `failed_permanent` or `abandoned`, filtered by `--key`, `--mr`,
  `--delivery`, `--since`/`--until` (or `--all`), with `--dry-run` to
  preview.
- **`bridge queue`** lists the actions waiting or retrying.
- **Audit trail** in `data/audit.jsonl`: every delivery and every Jira write,
  with outcome, delivery id, MR, labels before/after and the error on failure.
  `bridge audit` queries it; retention is pruned daily.
- **Docker:** `Dockerfile`, `compose.yaml`, `.env.example`.
- `config.yaml` supports `${VAR}` and `${VAR:-default}`; `GJB_HOST` and
  `GJB_PORT` override the listener.
- `/healthz` reports the version, `dry_run` and the queue size;
  `bridge version` prints the version.
- CI: typecheck, tests, build, and a Docker build that starts the image and
  waits for it to report healthy.

### Changed

- **The webhook no longer returns 502 when Jira fails.** It answers 200 once
  the actions are queued; Jira results are in the audit trail.
- **Reviewer labels are lowercase** (`reviewer-alice`, not `reviewer-Alice`),
  because Jira labels are case-sensitive. Removing a reviewer also removes the
  mixed-case label 0.1.0 wrote, so existing tickets are cleaned up as MRs
  change.

### Fixed

- **Webhooks are authenticated with `X-Gitlab-Token`.** 0.1.0 checked an
  `X-Hub-Signature-256` HMAC, which GitLab never sends, so every real
  delivery was rejected with 401.
- **Dry-run no longer consumes action ids.** Actions planned while
  `dry_run` was on were saved as done, so they were skipped as duplicates
  after switching it off.

## [0.1.0]

- First version: GitLab merge-request, approval and pipeline events to Jira
  labels (`needs-review`, `reviewer-<name>`, `approved`, `merged`, `draft`,
  `blocked-by-conflict`, `ci-failing`) and branch comments.
