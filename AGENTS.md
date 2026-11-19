# AGENTS.md

## Agent Skills

このプロジェクト用の Agent Skills は `.agents/skills/` に置く（Gemini CLI、Antigravity などがそのまま読み込む）。
Claude Code は `.claude/skills/` しか読まないため、`.claude/skills/<name>` から `.agents/skills/<name>` へのシンボリックリンクを置く。

| skill | 用途 |
| --- | --- |
| [work-log](.agents/skills/work-log/SKILL.md) | 作業記録（作業日誌）を GitHub issue「Work Log」(#2) に記録する |
| [croquet-shared-data](.agents/skills/croquet-shared-data/SKILL.md) | Croquet で大きなデータやプレイヤーが作った物（メッシュ・画像・自作の部品）を共有する。16KB の上限、ファイルサーバーと ID、モデルでの検証、タブレットでの確認 |

skills に対応していない AI は、上の表の用途にあたる作業をするときに、その SKILL.md を読んで従うこと。

### 外から入れた skill

`croquet-shared-data` は [yokobond/croquet-skills](https://github.com/yokobond/croquet-skills) から `gh skill install` で入れたもの（v0.3.0 に固定）。ここでは直接書き換えず、croquet-skills を直してリリースしてから入れ直す。

```bash
gh skill install yokobond/croquet-skills croquet-shared-data --pin <tag> --dir .agents/skills --force
```
