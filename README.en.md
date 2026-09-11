# Chirucat!

[中文](./README.md)

> A cross-platform multi-bot framework

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> Still in early development: there is no install-and-run package yet, and both features and usage will keep changing.
> This document will keep changing too.

---

## What can Chirucat do?

- **Cross-platform**: a bot can run on different platforms via adapters, and link users across them
- **Multi-bot**: create multiple bots carrying different plugins, each with its own independent set of features
- **Plugins are features**: what a bot can do is decided by its plugins — a feature can even appear on different platforms

## Quick Start

### 1. Install Node.js

Download and install the LTS version from [nodejs.org](https://nodejs.org).

### 2. Get Chirucat

Get the project code (git clone or unzip a release), open a terminal in the project folder, and run:

```bash
npm install
```

### 3. Start Chirucat

In the project root, run:

```bash
npm run app
```

After a short wait, the WebUI opens at `http://localhost:7636`.

### 4. Create your first bot

In the WebUI, open the **bots** page and click the "+" button at the top to bring up the bot creation dialog and create your own bot.

### Connecting a chat platform

To bring a bot onto a chat platform, install the corresponding **adapter** plugin (provided by the community). See that plugin's own documentation for setup.

## Concepts at a Glance

| Term | What it is |
| --- | --- |
| Bot | A chatbot instance with its own name and plugins |
| Plugin | A feature for the bot — install one, and the bot gains an ability |
| Adapter | The "bridge" between a bot and a chat platform — one per platform |

## For Developers

Want to build plugins or adapters for Chirucat? Read the [Plugin Development Guide](docs/plugin/index.md).

## Roadmap

See [TODO](TODO.md).

## License

[MIT](LICENSE) © 2026 9halfcirno
