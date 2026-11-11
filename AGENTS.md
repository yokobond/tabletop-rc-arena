# AGENTS.md

## Agent Skills

このプロジェクト用の Agent Skills は `.agents/skills/` に置く（Gemini CLI、Antigravity などがそのまま読み込む）。
Claude Code は `.claude/skills/` しか読まないため、`.claude/skills/<name>` から `.agents/skills/<name>` へのシンボリックリンクを置く。

| skill | 用途 |
| --- | --- |
| [work-log](.agents/skills/work-log/SKILL.md) | 作業記録（作業日誌）を GitHub issue「Work Log」(#2) に記録する |

skills に対応していない AI は、作業を記録するときに上の SKILL.md を読んで従うこと。
