/**
 * Entry point.
 *   serve                 run the webhook listener and the Jira worker
 *   plan <payload.json>   print the actions a payload would produce, touch nothing
 *   audit [filters]       print the audit trail, newest first
 *   queue                 print actions waiting to be applied or retried
 *   replay [filters]      re-queue failed/abandoned actions on the running server
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import buildLogger from './logger.js';
import { ConfigError, loadConfig } from './config/load.js';
import { buildApp } from './app.js';
import { DedupeStore } from './state/dedup.js';
import { AuditLog, noopAudit, type AuditRow } from './state/audit.js';
import { ActionQueue, readQueueFile } from './state/queue.js';
import { JiraClient } from './jira/client.js';
import { GitLabClient } from './gitlab/client.js';
import { Worker, writeReplayRequest } from './worker.js';
import { VERSION } from './version.js';
import { parseMergeRequestEvent, parsePipelineEvent } from './gitlab/webhook.js';
import { planActions, planPipelineActions } from './domain/actions.js';

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const log = buildLogger(config.log_level);

  if (command === 'plan') {
    const file = rest[0];
    if (!file) {
      console.error('usage: bridge plan <payload.json>');
      process.exit(2);
    }
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const mr = parseMergeRequestEvent(body);
    const pipe = mr ? null : parsePipelineEvent(body);
    if (!mr && !pipe) {
      console.error('not a merge_request or pipeline event');
      process.exit(2);
    }
    const plan = mr ? planActions(mr, config) : planPipelineActions(pipe!, config);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === 'audit') {
    printAudit(new AuditLog(config.audit.file), rest);
    return;
  }

  if (command === 'queue') {
    printQueue(config.retry.queue_file);
    return;
  }

  if (command === 'replay') {
    replay(new AuditLog(config.audit.file), config.retry.inbox_dir, rest);
    return;
  }

  if (command === 'version' || command === '--version') {
    console.log(VERSION);
    return;
  }

  if (command !== 'serve') {
    console.error(`unknown command: ${command} (expected serve, plan, audit, queue, replay or version)`);
    process.exit(2);
  }

  const state = new DedupeStore(config.state_file);
  const audit = config.audit.enabled
    ? new AuditLog(config.audit.file, (err) => log.error({ err: String(err) }, 'audit write failed'))
    : noopAudit;

  const prune = () => {
    if (!(audit instanceof AuditLog) || config.audit.retention_days === 0) return;
    try {
      const removed = audit.prune(config.audit.retention_days);
      if (removed > 0) log.info({ removed, retention_days: config.audit.retention_days }, 'audit pruned');
    } catch (err) {
      log.error({ err: String(err) }, 'audit prune failed');
    }
  };
  prune();
  const pruneTimer = setInterval(prune, DAY_MS);
  pruneTimer.unref();

  const queue = new ActionQueue(config.retry.queue_file);
  const gitlab = config.behaviours.comment_on_missing_key ? new GitLabClient(config, log) : undefined;
  const worker = new Worker(config, { queue, state, jira: new JiraClient(config, log), gitlab, audit, log });
  if (queue.size > 0) log.info({ pending: queue.size }, 'resuming queued actions from previous run');
  worker.start();

  const app = buildApp(config, { worker, queue, log, audit });
  await app.listen({ host: config.server.host, port: config.server.port });
  log.info(
    {
      version: VERSION,
      host: config.server.host,
      port: config.server.port,
      dry_run: config.behaviours.dry_run,
      audit: config.audit.enabled ? config.audit.file : false,
    },
    'gitlab-jira-bridge listening',
  );

  const shutdown = async () => {
    clearInterval(pruneTimer);
    await app.close(); // stop taking deliveries first
    await worker.stop(); // let the in-flight Jira call finish; the rest stays queued on disk
    if (!config.behaviours.dry_run) state.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printAudit(audit: AuditLog, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      mr: { type: 'string' },
      outcome: { type: 'string' },
      delivery: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string', default: '50' },
      json: { type: 'boolean', default: false },
    },
  });
  const rows = audit.list({
    key: values.key,
    mr_iid: values.mr ? Number(values.mr) : undefined,
    outcome: values.outcome,
    delivery: values.delivery,
    since: values.since,
    until: values.until,
    limit: Number(values.limit),
  });
  if (values.json) {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  if (rows.length === 0) {
    console.log('no matching audit entries');
    return;
  }
  for (const row of rows) console.log(formatRow(row));
}

function printQueue(file: string): void {
  const items = readQueueFile(file);
  if (items.length === 0) {
    console.log('queue is empty');
    return;
  }
  for (const item of items) {
    const tries = item.attempts > 0 ? `attempt ${item.attempts} failed, next ${item.next_at}` : 'waiting';
    console.log(`${item.enqueued_at}  ${item.action.key.padEnd(10)} ${item.action.id}  ${tries}${item.last_error ? `  (${item.last_error})` : ''}`);
  }
}

const REPLAYABLE = new Set(['failed_permanent', 'abandoned']);

/**
 * Selects actions whose latest audit entry is a failure and asks the running
 * server to queue them again (via the inbox, so this process never writes the
 * server's queue or state). A filter is required, so a typo cannot replay
 * everything that ever failed.
 */
function replay(audit: AuditLog, inboxDir: string, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      mr: { type: 'string' },
      delivery: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const filtered = Boolean(values.key || values.mr || values.delivery || values.since || values.until);
  if (!filtered && !values.all) {
    console.error('replay needs a filter (--key, --mr, --delivery, --since, --until) or --all');
    process.exit(2);
  }

  const rows = audit.list({
    key: values.key,
    mr_iid: values.mr ? Number(values.mr) : undefined,
    delivery: values.delivery,
    since: values.since,
    until: values.until,
    limit: Number.MAX_SAFE_INTEGER,
  });
  // Newest first: the first entry seen per action id is its latest state.
  const latest = new Map<string, AuditRow>();
  for (const row of rows) if (row.action_id && !latest.has(row.action_id)) latest.set(row.action_id, row);
  const picked = [...latest.values()].filter((r) => REPLAYABLE.has(r.outcome) && r.action).reverse();

  if (picked.length === 0) {
    console.log('nothing to replay: no matching action whose latest outcome is failed_permanent or abandoned');
    return;
  }
  for (const row of picked) console.log(formatRow(row));
  if (values['dry-run']) {
    console.log(`\n${picked.length} action(s) would be replayed (dry run, nothing queued)`);
    return;
  }
  const file = writeReplayRequest(inboxDir, {
    items: picked.map((r) => ({
      action: r.action!,
      context: { delivery: r.delivery, event: r.event, project: r.project, mr_iid: r.mr_iid, ref: r.ref },
    })),
  });
  console.log(`\n${picked.length} action(s) handed to the server (${file}); it picks them up within a few seconds.`);
  console.log('Follow with: bridge audit --outcome replay  /  bridge queue');
}

function formatRow(row: AuditRow): string {
  const where = [row.key, row.project && row.mr_iid !== undefined ? `${row.project}!${row.mr_iid}` : row.ref]
    .filter(Boolean)
    .join(' ');
  let what = '';
  if (row.kind === 'labels') {
    const change = [...(row.add ?? []).map((l) => `+${l}`), ...(row.remove ?? []).map((l) => `-${l}`)].join(' ');
    what = change;
    if (row.before && row.after && row.outcome === 'applied') {
      what += `  [${row.before.join(',')}] → [${row.after.join(',')}]`;
    }
  } else if (row.kind === 'comment' || row.kind === 'mr_note') {
    const text = (row.comment ?? '').replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
    what = `"${text.slice(0, 80)}"`;
  }
  const detail = row.detail ? `  (${row.detail})` : '';
  if (row.attempt && row.attempt > 1) what += `  [attempt ${row.attempt}]`;
  return `${row.at}  ${row.outcome.padEnd(16)} ${(row.event ?? '-').padEnd(13)} ${row.kind.padEnd(8)} ${where}  ${what}${detail}`.trimEnd();
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
