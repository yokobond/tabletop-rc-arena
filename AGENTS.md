# AGENTS.md

## コード変更時の必須手順

リポジトリのコードやドキュメントを変更するときは、ユーザーから「PR 作成まで」「まだマージしないで」などの明示的な指示がある場合を除き、**以下の手順をすべて完了させてから**作業完了とする。`main` ブランチへ直接コミット・プッシュしない。

1. **作業用ブランチで変更・検証する**
   - 最新の `origin/main` から作業用ブランチを作成して作業する（すでに作業用ブランチや worktree で作業している場合はそのまま続ける）。
   - 変更内容に応じた検証（`npm test`、`npm run build`、必要に応じたブラウザ確認など）を実行し、問題がないことを確認する。
   - テスト・ビルド・チェックが失敗している場合は次の手順へ進まず、修正するかユーザーへ報告する。
2. **ユーザーへ変更内容の確認を求め、了承を得る**
   - 一連の変更および検証が完了したら、**コミット・プッシュ・PR 作成・マージなどの作業に進む前に**、必ずユーザーへ変更内容と検証結果を提示して確認を求める。
   - ユーザーから了承を得た後にのみ、コミット以降の作業を行う。
3. **コミット・プッシュし、日本語で PR を作成する**
   - 変更をコミット・プッシュする。
   - **タイトル・本文ともに日本語**で Pull Request を作成する（`gh pr create`）。
   - PR 本文には、作業記録（Work Log）の根拠になるよう「背景・意図」「変更内容」「確認・テスト結果（未確認事項や制限があれば併記）」「関連 issue 番号」を書く。
4. **PR をマージする**
   - チェックに問題がなければ squash マージで `main` に取り込む。
     ```bash
     gh pr merge <PR番号> --squash --delete-branch
     ```
5. **作業用ブランチを削除し、`main` を最新にする**
   - リモート・ローカルの両方で作業用ブランチが削除されていることを確認する。
   - リモートブランチが残っていれば `git push origin --delete <branch>` で削除する。
   - ローカルは `main` へ戻して `origin/main` を取り込み、作業用ブランチを削除する（squash マージ後は `git branch -d` が未マージ警告を出すため、マージ済みを確認したうえで `git branch -D <branch>` を使う。worktree を使っていた場合は worktree を外してから削除する）。
     ```bash
     git checkout main
     git pull --ff-only origin main
     git branch -D <branch>
     ```
6. **作業記録（Work Log）を書く**
   - マージ完了後、必ず `work-log` スキル（[`.agents/skills/work-log/SKILL.md`](.agents/skills/work-log/SKILL.md)）に従って GitHub issue「Work Log」（#2）に作業記録を追記・更新する（1 日 1 コメント、同日のコメントが既にあれば編集する）。
7. **完了を報告する**
   - ユーザーへの報告には、マージした PR の番号・URL、作業用ブランチ削除済みであること、更新した Work Log コメントの URL を含める。

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
