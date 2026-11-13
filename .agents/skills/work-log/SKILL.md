---
name: work-log
description: このプロジェクト（tabletop-rc-arena）の作業記録（作業日誌）を GitHub issue「Work Log」(#2) に、1 日 1 コメントで追記する。「作業を記録して」「Work Log に書いて」「作業日誌を投稿して」「昨日の作業を記録して」など、作業記録・作業日誌・Work Log に触れられたときに使う。
---

# 作業記録（Work Log）

このプロジェクトの作業記録は、GitHub issue「Work Log」に、**1 日の作業をまとめた 1 件のコメント**として残す。

## 記録先

- GitHub issue「Work Log」（[yokobond/tabletop-rc-arena#2](https://github.com/yokobond/tabletop-rc-arena/issues/2)）に**コメントとして追記**する。
- 日付ごとや作業ごとに新しい issue を作らない。issue 本文も書き換えない。
- 「Work Log」issue が見つからないとき（`gh issue list --state all --search "Work Log in:title"` で確認）だけ、タイトル `Work Log` で作る。

## 単位

- **1 日 1 コメント**。その日に main に入った PR・コミットをすべて 1 件のコメントにまとめる。
- その日のコメントがすでにあれば、新しく投稿せずにそのコメントを編集して追記する。
- 日付は JST で区切る（main に入った時刻で判断）。

## 内容

コミットや PR の変更点の一覧ではなく、**その日の作業の意図と影響**を書く。変更の細部は PR を見れば分かるので繰り返さない。

- 関連する複数の PR・issue を 1 つの「テーマ」にまとめる（例: 「作業記録の仕組み」= #4 + #5）。
- テーマごとに次を書く。
  - **意図**: なぜやったか。何を解決したかったか（元になった issue やユーザーの要望）
  - **影響**: 遊び方・使い方・開発の進め方がどう変わったか。他の機能や今後の作業への影響
  - **残っていること**: 未確認の点や制限。PR 本文や issue に書かれているものだけ
- 関係する PR・issue 番号はテーマの見出しか本文に付け、詳細はそちらへのリンクに任せる。
- 最後に、その日全体を通して言えること（方向性の変化など）があれば 1〜2 行で書く。なければ書かない。

## 書式

```markdown
## YYYY-MM-DD の作業

<その日の概要を 1〜2 行>

### <テーマ> (#PR, #PR / issue #N)
- 意図: ...
- 影響: ...
- 残り: ...（あれば）

### <テーマ> (...)
...
```

- 日本語で書く。コード、コマンド、ファイル名、UI の表記はそのまま使う。
- 根拠は PR の本文、issue、コミットメッセージ、差分とし、推測は書かない。
- 「次にやること」は、ユーザーがそう言ったときか、PR や issue に書かれているときだけ書く。

## 手順

1. 対象日のコミットと PR を集める。
   ```bash
   git fetch -q
   git log origin/main --since="YYYY-MM-DD 00:00" --until="YYYY-MM-DD+1 00:00" --date=format:'%Y-%m-%d %H:%M' --pretty='%h %ad %s'
   gh pr list --state merged --search "merged:YYYY-MM-DD" --json number,title,mergedAt
   ```
   各 PR の本文と、関係する issue を `gh pr view <n>` / `gh issue view <n>` で読む。
2. その日のコメントがすでにあるか確認する。
   ```bash
   gh issue view 2 --comments --json comments -q '.comments[] | select(.body | startswith("## YYYY-MM-DD")) | .url'
   ```
3. 本文を一時ファイルに書いて投稿する。既存のコメントがあればそれを編集する。
   ```bash
   gh issue comment 2 --body-file <file>
   # 既存コメントの編集: gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<file>
   ```
4. 投稿したコメントの URL をユーザーに伝える。
