---
name: work-log
description: このプロジェクト（tabletop-rc-arena）の作業記録（作業日誌）を GitHub issue「Work Log」(#2) にコメントで追記する。「作業を記録して」「Work Log に書いて」「作業日誌を投稿して」「昨日の作業を記録して」など、作業記録・作業日誌・Work Log に触れられたときに使う。
---

# 作業記録（Work Log）

このプロジェクトの作業記録は、GitHub issue「Work Log」に、作業の一区切りごとのコメントとして残す。

## 記録先

- GitHub issue「Work Log」（[yokobond/tabletop-rc-arena#2](https://github.com/yokobond/tabletop-rc-arena/issues/2)）に**コメントとして追記**する。
- 日付ごとや作業ごとに新しい issue を作らない。issue 本文も書き換えない。
- 「Work Log」issue が見つからないとき（`gh issue list --state all --search "Work Log in:title"` で確認）だけ、タイトル `Work Log` で作る。

## 単位

- 作業の一区切りごとにコメント 1 件。原則は main に入ったコミット 1 件（または PR 1 件）でコメント 1 件。
- 同じ内容のコミット（cherry-pick、squash マージ前のブランチ上のコミットなど）は 1 件にまとめる。
- すでに記録したコミットや PR は二重に記録しない（見出しのハッシュや PR 番号で確認する）。

## 書式

```markdown
### YYYY-MM-DD HH:MM <作業の要約> (<短いコミットハッシュ>)
- <変更点を箇条書き>
- ...
```

- 日時はコミットした時刻（JST）。PR 単位のときはハッシュの代わりに `#<PR番号>` を書き、時刻は main に入った時刻にする。
- 日本語で書く。コード、コマンド、ファイル名、UI の表記はそのまま使う。
- 書くのは「何を、なぜ変えたか」。根拠はコミットメッセージや差分、PR の本文とし、推測は書かない。
- 「次にやること」や課題は、ユーザーがそう言ったときか、コミットや PR に書かれているときだけ書く。

## 手順

1. 対象期間のコミットを集める。
   ```bash
   git fetch -q
   git log origin/main --since="YYYY-MM-DD 00:00" --until="YYYY-MM-DD 00:00" --date=format:'%Y-%m-%d %H:%M' --pretty='%h %ad %s'
   ```
   各コミットの中身は `git show --stat <hash>` で確認する。
2. 既存の記録を確認し、記録済みのものを除く。
   ```bash
   gh issue view 2 --comments --json comments -q '.comments[].body' | grep '^###'
   ```
3. コメントの本文を一時ファイルに書き、1 件ずつ投稿する。
   ```bash
   gh issue comment 2 --body-file <file>
   ```
4. 投稿したコメントの URL をユーザーに伝える。
