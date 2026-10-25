# AI CLI Notify for Claude Code

This Claude Code plugin shows a small floating reminder when the current agent turn finishes, then collapses into a numbered desktop icon. It disappears when you return to the terminal or close its window. It has no buttons and does not include prompt or response text. It installs one Stop hook.

Install it through the AI CLI Notify marketplace:

```powershell
claude plugin marketplace add OWNER/REPO
claude plugin install ai-cli-notify@ai-cli-notify
```

The plugin runs its bundled PowerShell scripts with your Windows account privileges. Review the scripts before installing. It sends no network requests.
