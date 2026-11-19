# gitlab-jira-bridge

Turns GitLab merge-request events into Jira Cloud ticket state. When a reviewer
is assigned in an MR, the ticket gets `needs-review` and `reviewer-<username>`
labels. When the MR is approved, merged, or closed, the labels follow. Open and
merge also leave a comment with the branch name, so nobody has to hunt for it.

It is a **nudge, not a gate**: it annotates Jira, it never blocks anything, and
it writes only two things to Jira — labels it owns, and comments it starts with
a recognisable shape. Optionally it also tells the MR author when an MR cannot be
linked to a ticket ([below](#when-no-ticket-can-be-found)); that is its only
GitLab write, and it is off by default.

## What it does

| GitLab event | Jira effect |
| --- | --- |
| MR opened | Comment: branch → target + MR link. If reviewers already set: `needs-review` + `reviewer-*` |
| Title/description edit links the MR to a ticket | Same as MR opened, for that ticket (the key was added, an ambiguous title narrowed down, or the title now names a different ticket) |
| Reviewer assigned/changed | `needs-review` stays; old `reviewer-<u>` removed, new added; optional comment |
| Reviewer cleared | `needs-review` and `reviewer-*` removed |
| MR approved (approval event) | `approved` added, `needs-review` removed |
| MR merged | `merged` added; `needs-review`/`approved`/`reviewer-*`/`blocked-by-conflict`/`ci-failing` cleaned; comment with merge SHA and branch |
| MR closed | optional `closed` label, review/conflict/CI labels cleaned |
| Conflict appears | `blocked-by-conflict` added (`merge_status` → `cannot_be_merged`) |
| Conflict resolved | `blocked-by-conflict` removed |
| Draft ⇄ ready | `draft` label toggled; going draft withdraws `needs-review`, becoming ready with reviewers re-adds it. Also detected via `WIP:`/`Draft:` title prefixes |
| Pipeline failed | `ci-failing` added. **Success only removes it — there is no passing label**: green CI is the expected state, so the label marks exceptions only |

### What the comments look like

Ticket comments are two short lines, with the branch and target as monospaced
code and the MR as a link (Jira does not auto-link text posted through its API,
so the link is marked explicitly):

```
🔀 Merge request opened: `feature/abc-123` → `main`
[group/project !42](https://gitlab.example.com/group/project/-/merge_requests/42)
```

```
✅ Merged: `feature/abc-123` → `main` as `deadbeefcafe`
[group/project !42](https://gitlab.example.com/group/project/-/merge_requests/42)
```

### How the ticket is found

The bridge never asks GitLab or Jira which ticket an MR belongs to: it reads the
key from the webhook. It checks the **title, then the source branch, then the
description**, and the first of those that names **exactly one** key wins:

| Title | Branch | Description | Ticket |
| --- | --- | --- | --- |
| `ABC-1 Fix login` | `fix-login` | Follow-up of ABC-2 | **ABC-1** (title wins; the description is not consulted) |
| `Fix login` | `ABC-7-login` | | **ABC-7** |
| `Fix login` | `fix-login` | Closes ABC-9 | **ABC-9** |
| `ABC-1 / ABC-2 combined` | `ABC-3-x` | | **none** — the title is ambiguous, and the bridge does not guess |
| `Fix login` | `fix-login` | | **none** |

By default only uppercase keys count (`jira.key_regex`). To match lowercase
branches such as `feature/abc-123-login`, list your projects:

```yaml
jira:
  project_keys: [ABC, XYZ]
```

Keys are then matched in any case and only for those projects, so `bump-node-22`
or `utf-8` are never taken for tickets — which is why case-insensitive matching
is not offered without the list. `key_regex` is ignored while `project_keys` is
set, and an invalid `key_regex` stops the bridge at startup with a clear error.

Projects you do not act on can be named too. This is what keeps an MR that
belongs to them from being reported as unlinked:

```yaml
jira:
  project_keys: [ABC]
  other_project_keys: [XYZ, DEF]
```

A `XYZ-7` MR is then **foreign**: no labels, no comment, and — unlike a
missing key — never the "not linked to Jira" comment, because the MR *is*
linked, just to a project this bridge does not write to. The audit trail says
`foreign: title names XYZ-7 (not a tracked Jira project)`. Entries are matched
in any case, in both modes. Leaving the list empty keeps such keys invisible,
and an MR whose only key belongs to an untracked project then looks unlinked.

When no single key is found, nothing is written to Jira and the audit trail
records why (`bridge audit --outcome skipped`).

### When no ticket can be found

With `behaviours.comment_on_missing_key: true`, the bridge leaves one comment on
the MR saying it is not linked to Jira and how to fix it, naming the conflicting
keys when the problem is ambiguity:

> ⚠️ **This merge request is not linked to Jira.** No Jira ticket key was found in
> the title, the source branch or the description.
>
> Until it is, the ticket gets no review, approval or merge labels and no branch
> comment. Add the key to the title, e.g. `ABC-123 Fix login`. The bridge picks
> up the edit straight away.

- **Once per MR.** The comment carries a hidden marker; the bridge checks the
  MR's comments for it before posting, so redeliveries, restarts or a lost
  `state.json` cannot repeat it.
- **Only when it is news**: on open, reopen, and edits of the title or
  description that still leave no single key — never on approvals, pipelines or
  reviewer changes, and never on merged or closed MRs.
- **Skips** MRs opened or edited by `missing_key.skip_authors` (e.g.
  `renovate-bot`) and source branches starting with
  `missing_key.skip_branches` (e.g. `renovate/`, `release/`).
- **Fixing it works.** When the author then puts the key in the title, the
  bridge does what opening the MR would have done for that ticket (branch
  comment, `needs-review` for reviewers already assigned).

It needs a GitLab token in `GITLAB_TOKEN` (`gitlab.token: ${GITLAB_TOKEN}`).
GitLab has no scope narrower than **`api`** that can post comments, and `api` can
do much more, so create a **dedicated bot user with the Reporter role** on the
projects in scope and use its token. The bridge refuses to start with the
setting on and no token.

### Notes on the CI signal

Pipeline webhooks carry no MR reference, so the bridge takes the ticket key from
the pipeline `ref` (branch name) alone. `ci-failing` therefore works when branch
names contain the key: `ABC-123-widget`, or `feature/abc-123-widget` with
`project_keys` set. Refs with no key are ignored, which is the safe default.
Subscribe to **Pipeline events** in the webhook settings for this to fire.

## What it does NOT do

- No GitLab writes, except the optional missing-key comment above. Without it
  the bridge never needs a GitLab token; the only inbound secret is the
  webhook secret token.
- No real-time product of its own. It only reacts to webhook deliveries; if a
  delivery never reaches the bridge, the label is corrected by the next
  matching event, not back-filled. (Deliveries that do arrive are queued on
  disk and retried until Jira accepts them.) Deliberate: a poller would
  recreate the noise this family of tools exists to avoid.
- No custom-field writes, no transitions. Labels and comments only, because
  those two are safe to make idempotent without a schema conversation.

## Setup

1. Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`,
   fill them in, and **start with `behaviours.dry_run: true`** (or
   `GJB_DRY_RUN=1`). Secrets go in `.env`; `config.yaml` refers to them as
   `${VAR}` / `${VAR:-default}`.
2. Create the webhook in GitLab (project or group → Settings → Webhooks):
   - Trigger: **Merge request events** (plus **Approval events** for the
     `approved` label, and **Pipeline events** for `ci-failing`).
   - URL: `https://your-bridge-host/webhook`
   - Secret token: same value as `gitlab.webhook_secret`. GitLab sends it in
     the `X-Gitlab-Token` header and the bridge rejects any delivery without
     it (401, recorded in the audit trail as `rejected`). Leave GitLab's
     separate *Signing token* field empty; it is not checked.
   - SSL verification on; it must be HTTPS if exposed beyond localhost.
3. Create a Jira bot user (or use your own), get its API token at
   `https://id.atlassian.com/manage-profile/security/api-tokens`, and grant it
   *Browse* + *Add comment* + *Edit issues* on the projects in scope.
4. Run:

```bash
npm install
npm run build
set -a; . ./.env; set +a        # or export the variables another way
node dist/cli.js serve          # or: npm run dev
```

   Or with Docker — see [Docker](#docker).

5. Replay a real webhook capture against the planner before going live:

```bash
node dist/cli.js plan sample-payload.json
```

`plan` prints exactly the actions that would be applied, touches nothing.
Switch `dry_run` off when the output looks right.

## Audit trail

Every webhook delivery leaves a record in `audit.file` (default
`./data/audit.jsonl`, one JSON object per line, append-only), including the
ones that changed nothing. It answers "why does — or doesn't — ABC-123 carry
`needs-review`?" without trawling logs.

| Outcome | Meaning |
| --- | --- |
| `applied` | Jira was written. Label entries carry the ticket's labels `before` and `after` |
| `unchanged` | Jira already had exactly those labels; no write made |
| `dry_run` | `dry_run` is on; the write was logged instead |
| `duplicate` | The action id had already been processed (GitLab redelivery, restart) |
| `failed_permanent` | Jira 4xx (bad key, no permission). Marked done, will not retry |
| `failed_transient` | Jira 5xx/429/network. Retried automatically; `detail` says when |
| `abandoned` | Still failing after `retry.max_attempts`. Dropped from the queue; replayable |
| `replay_queued` | Put back on the queue by `bridge replay` |
| `rejected` | Bad or missing `X-Gitlab-Token`, or invalid JSON. Logged with the caller IP |
| `skipped` | Valid delivery that planned nothing, with the reason (no single Jira key, action not mapped, …) |

Each entry also has the GitLab delivery id (`X-Gitlab-Event-UUID`, which
matches *Recent events* in the webhook settings), event type, project, MR iid,
branch and the planner's action id. Long comments are cut to 500 characters.

```bash
node dist/cli.js audit --key ABC-123            # newest first, 50 by default
node dist/cli.js audit --mr 42 --since 2026-11-01
node dist/cli.js audit --outcome failed         # prefix match: both failure kinds
node dist/cli.js audit --delivery <uuid> --json # raw lines, for jq
tail -f data/audit.jsonl | jq .                 # live
```

Entries older than `audit.retention_days` (default 90, `0` = forever) are
pruned at startup and once a day. If pipeline chatter makes the file too
busy, `audit.record_skipped: false` drops the no-op deliveries; rejections
are always kept. A failing audit write (full disk) is logged, never turned
into a failed webhook.

Behind a reverse proxy, set `server.trust_proxy: true` so `source_ip` is
the real caller and not the proxy. Leave it off when the port is reachable
directly — `X-Forwarded-For` is then whatever the caller says.

## Retries and replay

The webhook does not wait for Jira. It plans the actions, writes them to
`retry.queue_file` (default `./data/queue.json`) and answers 200 straight
away; a background worker then applies them. This matters because GitLab
waits only about 10 seconds for a reply, does not retry a failed delivery on
its own, and disables a webhook that keeps failing. A slow or unavailable
Jira therefore never shows up in GitLab as a failed delivery.

- **Transient failures** (Jira 5xx, 429, network) are retried with
  exponential backoff: 30 s, 1 min, 2 min, … capped at 1 h, for up to 12
  attempts (about 5 hours). After that the action is recorded as `abandoned`.
  All three numbers are under `retry:` in the config.
- **Permanent failures** (Jira 4xx: wrong key, no permission) are recorded
  once and not retried.
- **Order is kept per ticket.** While an action for ABC-123 is waiting to be
  retried, later actions for ABC-123 wait behind it, so a delayed
  `+needs-review` can never land after the `+merged` that followed it. Other
  tickets are not held up.
- **Nothing is lost on restart.** The queue is on disk; a restarted bridge
  carries on where it stopped.

```bash
node dist/cli.js queue                         # what is waiting, and why
node dist/cli.js replay --key ABC-123 --dry-run
node dist/cli.js replay --key ABC-123          # or --mr, --delivery, --since/--until, --all
```

`replay` re-queues actions whose latest audit entry is `failed_permanent`
or `abandoned` — for example after fixing the bot's Jira permissions or
waiting out a long outage. It needs a filter (or `--all`). It does not touch
the queue itself: it drops a request in `retry.inbox_dir`, which the running
server picks up within about 5 seconds (or at its next start). `/healthz`
reports the version, `dry_run`, and how many actions are pending and retrying.

## Docker

```bash
cp config.example.yaml config.yaml
cp .env.example .env            # fill in the secrets
docker compose up -d --build
docker compose exec bridge node dist/cli.js audit --key ABC-123
```

- Multi-stage `Dockerfile` on `node:22-bookworm-slim`, running as the
  unprivileged `node` user, with a `/healthz` healthcheck.
- `config.yaml` is mounted read-only; the image sets `GJB_HOST=0.0.0.0` so it
  listens inside the container whatever the file says.
- `state.json`, `queue.json`, `audit.jsonl` and the replay inbox live in the
  `bridge-data` volume at `/app/data`, so all of them survive rebuilds.
- The other commands run inside the container the same way:
  `docker compose exec bridge node dist/cli.js queue` (or `replay …`).
- The port is published on `127.0.0.1:8090` only. GitLab must reach
  `/webhook` over HTTPS, so put your reverse proxy in front of it.
- `plan` works in the container too:
  `docker compose run --rm -v ./sample.json:/tmp/p.json:ro bridge plan /tmp/p.json`.

| Variable | Effect |
| --- | --- |
| `GJB_CONFIG` | Path to config.yaml (image: `/app/config/config.yaml`) |
| `GJB_DRY_RUN=1` | Force dry-run on top of the file |
| `GJB_HOST`, `GJB_PORT` | Override `server.host` / `server.port` |

CI builds the image on every pull request, starts it and waits for the
container healthcheck to pass.

## Design notes

- **One mapping file.** `src/domain/actions.ts` is the only place that knows
  both GitLab semantics and Jira vocabulary. Everything else (webhook parsing,
  dedup, Jira client) is content-agnostic. Adding a signal is adding a case.
- **Idempotence by action id.** Each planned action carries a deterministic id
  (`<mr-id>:reviewer:<names>` etc.). Redelivered webhooks and restarts are
  recognised by it; ids live in `state_file`, capped at the most recent 50k.
- **Comments are checked on the ticket too.** Each Jira comment carries an
  invisible entity property with its action id, and the 50 most recent
  comments are checked before posting. So a crash between a successful post
  and saving `state_file`, a lost `state_file`, or an id older than the 50k cap
  cannot post the same comment twice. The MR comment works the same way with
  a hidden marker.
- **Labels are added and removed, never replaced.** Changes go through Jira's
  `update.labels` add/remove operations, which Jira applies to the ticket as it
  is at that moment: a label someone edits by hand while the bridge is working
  is kept. The bridge reads the labels first only to skip no-op writes and to
  record before/after in the audit trail.
- **Dry-run consumes nothing.** Actions planned in dry-run are not recorded
  in `state_file`, so switching dry-run off and redelivering applies them.
- **Permanent vs transient Jira failures.** A 404 (bad key, no access) is
  logged and marked done — no retry storm. A 5xx/429 is retried by the
  bridge's own queue, never left to GitLab (see
  [Retries and replay](#retries-and-replay)).
- **Lowercase reviewer labels.** Jira labels are case-sensitive, so
  `reviewer-<username>` is always lowercase. Removals also take out the
  mixed-case form older versions wrote.

## Family

Built in the same spirit as [ReviewNudge](https://github.com/sim186/ReviewNudge):
small TypeScript service, YAML config validated with zod, honest README about
what it will not do. ReviewNudge answers "who is sitting on this MR"; this
answers "what is true about this MR inside Jira". They can run side by side
against the same GitLab; neither needs write access to it.
