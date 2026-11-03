/**
 * Event bus for option B — RabbitMQ, one topic exchange `orders`.
 *
 * - Each service has its own durable queue (named after the service), bound
 *   to the event types it handles. The routing key is the event type.
 * - Messages are persistent, and publish() resolves only once the broker has
 *   confirmed the message (publisher confirms): "published" means "durable".
 * - Consumers ack after processing (at-least-once delivery) and process at
 *   most PREFETCH messages in parallel — the same concurrency as the HTTP
 *   pool of option A.
 * - Trace context is injected into the message headers on publish and
 *   extracted on consume, so one order gives one trace across all services.
 * - Scenario S5: DUPLICATE_RATE publishes some events twice with the same
 *   eventId (simulated redelivery); IDEMPOTENCY=on makes consumers ignore an
 *   eventId they have already processed.
 */

const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { context, propagation, trace, SpanKind, SpanStatusCode, ROOT_CONTEXT } = require('@opentelemetry/api');
const { client, sleep } = require('./runtime');

const EXCHANGE = 'orders';
const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672';
const PREFETCH = Number(process.env.PREFETCH || 100);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE || 0);
const IDEMPOTENCY = (process.env.IDEMPOTENCY || 'on') === 'on';

const tracer = trace.getTracer('bus');

const published = new client.Counter({ name: 'events_published_total', help: 'Events published (confirmed by the broker)', labelNames: ['type'] });
const consumed = new client.Counter({ name: 'events_consumed_total', help: 'Events processed', labelNames: ['type'] });
const failed = new client.Counter({ name: 'events_failed_total', help: 'Events whose processing threw', labelNames: ['type'] });
const duplicatesInjected = new client.Counter({ name: 'events_duplicates_injected_total', help: 'Events published twice on purpose (S5)', labelNames: ['type'] });
const duplicatesIgnored = new client.Counter({ name: 'events_duplicates_ignored_total', help: 'Already processed events ignored by the idempotent consumer', labelNames: ['type'] });
const storeSize = new client.Gauge({ name: 'idempotency_store_size', help: 'Event ids kept to detect duplicates (memory cost of idempotence)' });
new client.Gauge({ name: 'idempotency_enabled', help: '1 if consumers deduplicate by eventId' }).set(IDEMPOTENCY ? 1 : 0);

async function connect() {
  for (;;) {
    try {
      return await amqp.connect(AMQP_URL);
    } catch {
      console.log('[bus] broker not ready, retrying in 1 s');
      await sleep(1000);
    }
  }
}

async function createBus(service) {
  const connection = await connect();
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.prefetch(PREFETCH);
  connection.on('close', () => console.error('[bus] connection to the broker closed'));

  const processed = new Set(); // event ids already handled (idempotence)
  let handlers = {};
  let consumerTag = null;

  function send(event, headers) {
    return new Promise((resolve, reject) =>
      channel.publish(
        EXCHANGE,
        event.type,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, contentType: 'application/json', messageId: event.eventId, headers },
        (err) => (err ? reject(err) : resolve())
      )
    );
  }

  /** Publishes an event and resolves when the broker has confirmed it. */
  function publish(type, data) {
    const event = { eventId: randomUUID(), type, occurredAt: new Date().toISOString(), ...data };
    const attributes = {
      'messaging.system': 'rabbitmq',
      'messaging.destination.name': `${EXCHANGE}/${type}`,
      'messaging.message.id': event.eventId,
      'order.id': data.orderId,
    };
    return tracer.startActiveSpan(`publish ${type}`, { kind: SpanKind.PRODUCER, attributes }, async (span) => {
      const headers = {};
      propagation.inject(context.active(), headers); // trace context travels with the message
      try {
        const copies = Math.random() < DUPLICATE_RATE ? 2 : 1;
        if (copies === 2) duplicatesInjected.inc({ type });
        await Promise.all(Array.from({ length: copies }, () => send(event, headers)));
        published.inc({ type });
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async function onMessage(msg) {
    if (!msg) return; // consumer cancelled by the broker
    const event = JSON.parse(msg.content.toString());
    const parent = propagation.extract(ROOT_CONTEXT, msg.properties.headers || {});
    const attributes = {
      'messaging.system': 'rabbitmq',
      'messaging.destination.name': service,
      'messaging.message.id': event.eventId,
      'order.id': event.orderId,
    };
    const span = tracer.startSpan(`consume ${event.type}`, { kind: SpanKind.CONSUMER, attributes }, parent);

    await context.with(trace.setSpan(parent, span), async () => {
      // Mark the id *before* processing: a duplicate delivered while the first
      // copy is still being processed must also be ignored.
      const duplicate = IDEMPOTENCY && processed.has(event.eventId);
      try {
        if (duplicate) {
          duplicatesIgnored.inc({ type: event.type });
          span.setAttribute('event.duplicate_ignored', true);
        } else {
          if (IDEMPOTENCY) {
            processed.add(event.eventId);
            storeSize.set(processed.size);
          }
          await handlers[event.type](event);
          consumed.inc({ type: event.type });
        }
        channel.ack(msg);
      } catch (err) {
        if (!duplicate) processed.delete(event.eventId);
        failed.inc({ type: event.type });
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        console.error(`[bus] ${event.type} ${event.eventId} failed: ${err.message}`);
        channel.nack(msg, false, false); // no infinite redelivery loop (limitation: no dead-letter queue)
      } finally {
        span.end();
      }
    });
  }

  async function startConsuming() {
    ({ consumerTag } = await channel.consume(service, onMessage));
  }

  /** Declares the service queue, binds it to the handled event types and starts consuming. */
  async function subscribe(eventHandlers) {
    handlers = eventHandlers;
    await channel.assertQueue(service, { durable: true });
    for (const type of Object.keys(handlers)) await channel.bindQueue(service, EXCHANGE, type);
    await startConsuming();
  }

  /** Scenario S4: the service stops consuming; its messages wait in its queue. */
  async function pause() {
    if (consumerTag) await channel.cancel(consumerTag);
    consumerTag = null;
  }

  async function resume() {
    if (!consumerTag) await startConsuming();
  }

  return { publish, subscribe, pause, resume };
}

module.exports = { createBus, IDEMPOTENCY };
