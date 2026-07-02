# Claude Code を OAuth（claude.ai サブスク）で起動する。
# Cursor 統合ターミナルは ANTHROPIC_API_KEY を注入するため、起動前に外す。
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

& claude @args
