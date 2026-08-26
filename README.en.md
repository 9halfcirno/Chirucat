# Chirucat!

> One program. Multiple bots. On multiple chat platforms at the same time.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> This project is still in active development. Features and usage will keep changing.

---

## What can Chirucat do?

- **One bot, many platforms**: the same bot can appear on several chat platforms at once — wherever your users chat, the bot can answer
- **One program, many bots**: create as many bots as you want; they run independently and can share the same set of features
- **Plugins are features**: what a bot can do is decided by its plugins. Need a feature? Install the plugin for it
- **Recognizes users across platforms**: the same person on different platforms is identified as one user, enabling cross-platform features

## Quick Start

No programming required — just follow the steps.

### 1. Install Node.js

Download and install the LTS version from [nodejs.org](https://nodejs.org).

### 2. Get Chirucat

Get the project code (git clone or unzip a release), open a terminal in the project folder, and run:

```bash
npm install
```

### 3. Create your bot

Create a new folder inside `bots/` (e.g. `my-bot`), then create `config.json` inside it:

```json
{
  "id": "my-bot",
  "name": "My Bot"
}
```

- `id`: the bot's unique identifier (must not be duplicated)
- `name`: the bot's display name

### 4. Install plugins for your bot

Plugins are where bot features come from. Put a plugin folder into:

- `plugins/` — shared by all bots
- `your-bot-folder/plugins/` — used by this bot only

Then enable the plugins you want in the bot's `state.json`:

```json
{
  "enable": true,
  "plugins": {
    "ping": true
  }
}
```

- `enable`: whether the bot runs
- `plugins`: per-plugin toggles — `true` on, `false` off

### 5. Start

In the project folder, run:

```bash
npm test
```

Your bot is now running according to the config.

### Connecting a chat platform

To bring a bot onto a chat platform, install the corresponding **adapter** plugin for it (provided by the community). See that plugin's own documentation for setup.

## Concepts at a Glance

| Term | What it is |
| --- | --- |
| Bot | A chatbot instance with its own name and plugins |
| Plugin | A feature for the bot — install one, and the bot gains an ability |
| Adapter | The "bridge" between a bot and a chat platform — one per platform |

## For Developers

Want to build plugins or adapters for Chirucat? Read the [Plugin Development Guide](docs/PLUGIN_DEV.md).

## Roadmap

- [ ] **WebUI management**: manage bots from a web page instead of editing files
- [ ] **Plugin dependencies**: plugins can work together
- [ ] **Plugin marketplace**: download and publish plugins like an app store

## License

[MIT](LICENSE) © 2026 9halfcirno
