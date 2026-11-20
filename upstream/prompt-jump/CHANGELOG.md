# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Demo GIF in the README.
- Listing icon for the plugin directory.
- "Privacy and security" section in the README: what the mod reads, the exact local commands it runs, and that it sends nothing.

## [0.1.0] - 2026-10-09

First public release.

### Added

- `/jump` panel that lists every prompt of the current conversation, newest first, numbered in conversation order.
- Search by words (all words must match) or by number (`12`, `#12`), also as an argument: `/jump bypass`, `/jump 12`.
- Jump to a prompt by scrolling the transcript to it. The panel stays open so you can hop between prompts.
- Works right after `--resume`, including prompts you have not scrolled to yet, by reading prompt rows from the session transcript.
- Leaves out rewound prompts, slash commands, task notifications and messages from other sessions.
- Cuts long Korean, Chinese and Japanese prompts to the panel width by terminal cell width.

[0.1.0]: https://github.com/nickhealthy/claude-code-prompt-jump/releases/tag/prompt-jump--v0.1.0
