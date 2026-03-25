# Security Notes

This project exposes a Telegram bot as a remote control surface for Codex CLI.
Treat it as a privileged interface to the host machine.

## Deployment Basics

- Never commit `.env` or bot tokens.
- Restrict `ALLOWED_TELEGRAM_USER_IDS` to trusted accounts only.
- Prefer a dedicated bot token for this bridge. Rotate the token if it has ever been exposed.
- Prefer `CODEX_APPROVAL_MODE=on-request` unless you explicitly want unattended execution.
- Treat `CODEX_APPROVAL_MODE=never` and `CODEX_SANDBOX_MODE=danger-full-access` as high-risk settings.
- Treat `CODEX_BYPASS_APPROVALS_AND_SANDBOX=1` as the highest-risk setting in this repository.
- `CODEX_FULL_AUTO` is still accepted for compatibility, but new deployments should use `CODEX_APPROVAL_MODE`.
- Use a dedicated work directory and avoid pointing `CODEX_WORKDIR` at unrelated personal or production paths.

## If Something Leaks

1. Revoke the Telegram bot token in `@BotFather`.
2. Replace the token in `.env`.
3. Review `ALLOWED_TELEGRAM_USER_IDS`.
4. Inspect the local Codex and shell history for unintended commands.

## Reporting

If you discover a security issue, avoid publishing secrets, tokens, or machine details in a public issue.
