/**
 * OpenTelemetry tracing — loaded before the service with `node --require`,
 * because the HTTP instrumentation must patch `http` before Express loads it.
 *
 * Configuration comes from the standard OTEL_* environment variables:
 *   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT (Tempo),
 *   OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG (sampling ratio under load).
 *
 * Option A: trace context travels in HTTP headers (automatic).
 * Option B: trace context travels in AMQP message headers (see bus.js).
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

// Technical endpoints are not part of the business workflow: no spans for them.
const IGNORED_PATHS = ['/metrics', '/health', '/audit', '/admin', '/stats'];

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => IGNORED_PATHS.some((p) => req.url.startsWith(p)),
      }),
      new ExpressInstrumentation({ ignoreLayersType: ['middleware'] }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
}
