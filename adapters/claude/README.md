# AI CLI Notify for Claude Code

When a Claude Code turn finishes, this plugin shows a large desktop Anya reminder. It stays fixed in size while you hover or drag it, aggregates completed terminal tasks, and clears a terminal's reminders when you return to that terminal. It never includes prompt, code, or response text.

Install it through the AI CLI Notify marketplace:

```powershell
claude plugin marketplace add OWNER/REPO
claude plugin install ai-cli-notify@ai-cli-notify
```

After installing from a cloned GitHub repository, prepare the shared Electron runtime once from the plugin or repository directory:

```powershell
node .\anya-notifier\scripts\ensure-electron.js
```

The plugin uses its bundled PowerShell hook with your Windows account privileges; review the scripts before installing. Runtime setup downloads a checksum-verified Electron runtime, and Anya downloads its artwork on first use. Electron and artwork are cached per user, not duplicated in this plugin. No account or prompt data is sent to a notification service.
