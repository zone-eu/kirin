# Kirin

Kirin is a small, clusterable SMTP receiver built on
[`smtp-server`](https://www.npmjs.com/package/smtp-server). It exposes
ZoneMTA-compatible receiver hooks through `@zone-eu/wild-plugins` and can run
directly with Node.js or in a container.

> [!WARNING]
> This repository is a receiver foundation, not a complete mail service. No
> delivery or storage plugin is enabled by default. A message accepted by the
> default configuration is released after the DATA hook and is not persisted.

## Features

- Single-process development mode or multi-process execution with Node.js
  `cluster`
- ZoneMTA-compatible SMTP hook contracts
- Configurable SMTP size, connection, authentication, proxy, and TLS settings
- Graceful signal handling and plugin shutdown hooks
- Docker image support
- Contract tests and JavaScript type checking

## Requirements

- Node.js 20 or newer
- npm
- Docker (optional)

## Quick start

Install the locked dependency set and run the checks:

```bash
npm ci
npm run check
```

Start the receiver:

```bash
npm start
```

The development default listens on `127.0.0.1:2525`. It does not advertise
AUTH or STARTTLS and does not load a delivery plugin.

## Configuration

Configuration is loaded by `@zone-eu/wild-config`. The repository defaults are
in [`config/default.toml`](config/default.toml). Keep deployment settings and
secrets outside the repository and load them with `NODE_CONFIG_PATH` or
`--config`:

```bash
NODE_CONFIG_PATH=/etc/kirin.toml npm start
npm start -- --config=/etc/kirin.toml
```

Existing values can also be overridden with `APPCONF_` environment variables
or dotted command-line arguments:

```bash
APPCONF_smtp_port=2500 npm start
npm start -- --smtp.port=2500
```

Inspect the fully merged configuration without starting the SMTP listener:

```bash
npm run show-config
```

Important settings include:

- `processes`: `1` for a single process or `"cpus"` for one worker per CPU
- `smtp.host`, `smtp.port`, and `smtp.name`: listener and SMTP identity
- `smtp.size`: advertised and enforced maximum message size in bytes
- `smtp.dataHookTimeout`: maximum duration of the DATA plugin hook in
  milliseconds
- `smtp.maxClients`: maximum simultaneous SMTP connections per worker
- `smtp.authentication`: whether AUTH may be advertised
- `smtp.authOptional`: whether unauthenticated mail commands are permitted
- `smtp.disableSTARTTLS`: whether the STARTTLS command is disabled
- `smtp.tls`: paths to the private key, certificate, and optional CA bundle
- `plugins.pluginsPath`: base directory used to resolve plugin directories
- `plugins.conf`: optional plugin configuration included from
  `config/plugins/*.toml`

### TLS and authentication

STARTTLS is disabled in the development configuration because no certificate
or private key is bundled. To enable it, use deployment-specific configuration
that sets `smtp.disableSTARTTLS = false` and supplies readable
`smtp.tls.keyPath` and `smtp.tls.certPath` files.

Setting `smtp.authentication = true` is not sufficient by itself: an enabled
plugin must implement `smtp:auth`. Set `smtp.authOptional = false` only after
that hook is configured and tested. Do not offer plaintext authentication over
an unencrypted public connection.

### Plugins

Plugin settings are included by this directive in `config/default.toml`:

```toml
[plugins]
pluginsPath = "."

[plugins.conf]
# @include "plugins/*.toml"
```

The plugin path is resolved from the repository root. For example, the config
key `example-plugin` resolves to the directory `./example-plugin`. No plugin
code or plugin configuration is included by default. Add plugin configuration
under `config/plugins/`, keep its secrets in deployment-specific configuration,
and set the plugin's `enabled` value explicitly. Plugins run in ascending
`ordering` value.

The receiver exposes these hooks:

- `smtp:connect(session)`
- `smtp:auth(auth, session)`
- `smtp:mail_from(address, session)`
- `smtp:rcpt_to(address, session)`
- `smtp:data(envelope, session)`

The receiver-specific connection and transaction adapters remain internal. A
plugin can obtain the matching connection through the plugin handler's
`getConnection(session)` helper.

## Message buffering

SMTP DATA is fully buffered in memory before `smtp:data(envelope, session)`
runs. The buffer is released immediately after the hook completes, fails, or
times out. The `smtp-server` size option advertises and enforces `smtp.size`;
oversized messages receive a `552` response after the input stream has been
drained.

Memory use therefore scales with message size and concurrent DATA sessions.
Choose conservative `smtp.size`, `smtp.maxClients`, and `processes` values for
the available memory before exposing the service to untrusted clients.

Unhandled promise rejections and uncaught exceptions are logged without
explicitly terminating the worker. Worker startup is attempted once and a
failed startup is not retried. Run the service under a supervisor and monitor
its readiness in production.

## Container

Build and run the image:

```bash
docker build -t kirin .
docker run --rm -p 2525:2525 kirin
```

The image sets the in-container listener to `0.0.0.0`; publishing the port is
still an explicit `docker run` choice. To use an external configuration file:

```bash
docker run --rm -p 2525:2525 \
  -v /etc/kirin.toml:/run/kirin.toml:ro \
  kirin node server.js --config=/run/kirin.toml
```

## Development commands

```bash
npm test              # run the Mocha test suite
npm run typecheck     # check JavaScript and declaration files with TypeScript
npm run check         # run both type checking and tests
npm run show-config   # print merged configuration and exit
```

Before a production deployment, configure durable delivery, use a real SMTP
hostname and DNS records, supply TLS certificates, rotate all plugin secrets,
restrict trusted proxy extensions, set resource limits, and add service
supervision and monitoring.
