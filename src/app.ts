/**
 * Fastify app: one webhook endpoint plus a health check. The preParsing hook
 * keeps the raw body on the request so it can be parsed only after the
 * X-Gitlab-Token check has passed.
 *
 * The webhook only plans and queues. It answers as soon as the queue is on
 * disk; the worker applies the actions to Jira. GitLab waits about 10 seconds
 * for a reply and disables hooks that keep failing, so a slow or down Jira
 * must never show up as a failed delivery.
 */
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/schema.js';
import { parseMergeRequestEvent, parsePipelineEvent, verifyToken } from './gitlab/webhook.js';
import { planActions, planPipelineActions } from './domain/actions.js';
import { noopAudit, type AuditSink } from './state/audit.js';
import type { ActionQueue, AuditContext } from './state/queue.js';
import type { Worker } from './worker.js';
import { VERSION } from './version.js';
import type { Logger } from 'pino';

export type AppDeps = {
  worker: Worker;
  queue: ActionQueue;
  log: Logger;
  audit?: AuditSink;
};

export function buildApp(config: Config, deps: AppDeps): FastifyInstance {
  const { worker, queue, log } = deps;
  const audit = deps.audit ?? noopAudit;
  // trustProxy so request.ip is the caller, not the reverse proxy, in the audit trail.
  const app = Fastify({ logger: false, trustProxy: config.server.trust_proxy });

  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    (request as { rawBody?: Buffer }).rawBody = raw;
    return Readable.from(raw);
  });

  // Rejections are always recorded (they are the security-relevant ones);
  // no-op deliveries only when record_skipped is on.
  const recordSkip = (entry: Parameters<AuditSink['record']>[0]) => {
    if (config.audit.record_skipped) audit.record(entry);
  };

  app.get('/healthz', async () => ({
    ok: true,
    version: VERSION,
    dry_run: config.behaviours.dry_run,
    queue: { pending: queue.size, retrying: queue.all().filter((i) => i.attempts > 0).length },
  }));

  app.post('/webhook', async (request, reply) => {
    const rawBody = (request as { rawBody?: string | Buffer }).rawBody ?? request.body;
    const token = request.headers['x-gitlab-token'] as string | undefined;
    const delivery = request.headers['x-gitlab-event-uuid'] as string | undefined;
    const caller: AuditContext = { delivery, source_ip: request.ip };

    if (!verifyToken(token, config.gitlab.webhook_secret)) {
      log.warn({ source_ip: request.ip }, 'webhook rejected: bad or missing X-Gitlab-Token');
      audit.record({
        ...caller,
        kind: 'webhook',
        outcome: 'rejected',
        detail: token ? 'token mismatch' : 'missing X-Gitlab-Token header',
      });
      return reply.code(401).send({ error: 'invalid token' });
    }

    let body: unknown;
    try {
      body = typeof rawBody === 'string' || Buffer.isBuffer(rawBody)
        ? JSON.parse(rawBody.toString('utf8'))
        : rawBody;
    } catch {
      audit.record({ ...caller, kind: 'webhook', outcome: 'rejected', detail: 'invalid json' });
      return reply.code(400).send({ error: 'invalid json' });
    }

    const mrPayload = parseMergeRequestEvent(body);
    const pipePayload = mrPayload ? null : parsePipelineEvent(body);
    if (!mrPayload && !pipePayload) {
      const kind = (body as { object_kind?: unknown } | null)?.object_kind;
      recordSkip({
        ...caller,
        event: typeof kind === 'string' ? kind : 'unknown',
        kind: 'webhook',
        outcome: 'skipped',
        detail: 'event kind not handled',
      });
      return reply.code(200).send({ ignored: 'event kind not handled' });
    }

    const context: AuditContext = mrPayload
      ? {
          ...caller,
          event: mrPayload.event_type === 'approval' ? 'approval' : 'merge_request',
          project: mrPayload.project?.path_with_namespace,
          mr_iid: mrPayload.object_attributes.iid,
          ref: mrPayload.object_attributes.source_branch,
        }
      : {
          ...caller,
          event: 'pipeline',
          project: pipePayload!.project?.path_with_namespace,
          ref: pipePayload!.object_attributes.ref,
        };

    const plan = mrPayload ? planActions(mrPayload, config) : planPipelineActions(pipePayload!, config);
    if (plan.actions.length === 0) {
      log.debug({ event: context.event, reason: plan.skipped }, 'no actions planned');
      recordSkip({
        ...context,
        kind: 'webhook',
        outcome: 'skipped',
        detail: plan.skipped ?? 'nothing to do for this event',
      });
      return reply.code(200).send({ planned: 0, reason: plan.skipped });
    }

    const result = worker.enqueue(plan.actions, context);
    log.info(
      {
        event: context.event,
        delivery,
        ref: mrPayload ? mrPayload.object_attributes.iid : pipePayload!.object_attributes.ref,
        queued: result.queued.length,
        duplicates: result.duplicates.length,
      },
      'webhook queued',
    );
    return reply.code(200).send(result);
  });

  return app;
}
