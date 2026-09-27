# Chirucat!

[中文](./README.md)

> A cross-platform multi-bot framework

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> Still in early development: features are not fully complete yet, and it is currently in a basic usable stage.
> This document will keep changing as well.

---

## What can Chirucat do?

- **Cross-platform**: Bots can run on different platforms via adapters and link users across them.
- **Multi-bot**: Create multiple bots carrying different plugins to implement independent features and content.
- **Plugins are features**: Each bot's features are determined by its plugins—a feature can even appear across different platforms.

## Quick Start

### 1. Install Node.js

Download and install the LTS version from [nodejs.org](https://nodejs.org).

> Node 24 is recommended. If you encounter dependency package version issues, please try downgrading the dependency versions in `package.json`.
>
> The minimum supported version is Node 22, as some code utilizes newer syntax.

### 2. Get Chirucat

Get the project code (git clone or unzip a release), open a terminal in the project folder, and run:

```bash
npm install
```

### 3. Start Chirucat

In the project root directory, run:

```bash
npm run app
```

After waiting a moment, the WebUI will open locally at `http://localhost:7636`.

If this is your first time starting up, a default configuration will be generated. The password for the WebUI will be printed in the terminal and can subsequently be viewed in `configs/webui.json`.

### 4. Create your first Bot

In the WebUI, open the **bots** page, click the "+" button at the top to bring up the bot creation dialog, and create your own bot.

### Connecting a chat platform

To bring a bot onto a chat platform, you need to install the corresponding "adapter" plugin (provided by the community). See the documentation of the respective plugin for connection instructions.

> The framework provides ready-to-use simple adapters for QQbot and OneBot11!

## Concepts at a Glance

| Term | What it is |
| --- | --- |
| Bot | A chatbot instance with its own name, configurations, and plugins |
| Plugin | A module used to extend bot features; most bot functionalities are provided by plugins |
| Adapter | The "bridge" connecting a bot and a chat platform—which is also a plugin |

## For Developers

Want to build plugins or adapters for Chirucat? Please read the [Plugin Development Guide](docs/plugin/index.md)!

## Roadmap

See [TODO](TODO.md) for details.

## License

[MIT](LICENSE) © 2026 9halfcirno