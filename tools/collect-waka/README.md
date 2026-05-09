# collect-waka

`@haiku` ボット (`npub1ft7qy8qrf4huyk48nz0jf7parw3pfjs24az7py80ex8ympnqw6csz85fxu`) が投稿した、
本文に `#n57577` を含む kind:1 ノートを kind:10002 で公開されているリレー群から収集し、
`waka.jsonl` (1 行 = 1 イベント JSON, id でユニーク化, created_at 昇順) に書き出す。

ボットは `t` タグを付けず本文中にハッシュタグを書くだけなので、リレーには
author + kind フィルタでバッチ取得し、ローカルで content マッチさせる方式。

## Requirements

- [`nak`](https://github.com/fiatjaf/nak)
- `jq`

## Usage

```bash
./collect-waka.sh                  # -> <repo-root>/waka.jsonl
./collect-waka.sh /path/to/out.jsonl
BATCH_LIMIT=200 ./collect-waka.sh  # 1 リクエストあたり 200 件で since/until ページング
HASHTAG="#n575" ./collect-waka.sh  # 抽出するハッシュタグを変更
```

既存の出力ファイルがあれば内容をマージしてから再収集するので、再実行で増分取得になる。

## How it works

`nak req --paginate` を使い、`-l` で指定した件数を 1 バッチとして
`until` を遡らせながら全件取得する (NIP-01 の `since`/`until` フィルタ)。
リレーごとに失敗しても他リレーの取得は続行する。

## author-statistics.sh

`waka.jsonl` を解析して、引用元の和歌の詠み人 (author) を集計しランキング表示する。
さらに `data/waka.tsv` (flag=1 で採用した行) に対応する author の kind:0 プロフィールを
`data/author.tsv` に書き出す。

```bash
./author-statistics.sh
./author-statistics.sh path/to/waka.jsonl
```

### ランキング (stdout)

各イベントの `content` 中の `nostr:nevent1...` を `nak decode` して author を取り出す。
nevent1 がない (e タグだけの) イベントについては、e タグの id をリレーに REQ して
元イベントから author を補完する。リレー fetch 結果は `.cache/events-by-id.jsonl`
にキャッシュされ、再実行時はキャッシュ済みのイベントは fetch しない。
`waka.jsonl` 全体の author 出現数で降順ランキングを stdout に出す
(各リレーから `kind:0` を取って display_name 付き)。

### data/author.tsv

`data/waka.tsv` が存在するときに自動生成される。flag=1 の行の `note1` (col 12) を
イベント id にデコードし、`originalid -> author` マップで author を引き当てる。
得られた author 集合に対して `kind:0` プロフィール (4 リレー: yabu.me /
relay-jp.nostr.wirednet.jp / nos.lol / purplepag.es) を取得し、最新 created_at の
content (JSON) から `name` / `display_name` (or `displayName`) / `picture` を抽出。

| 列 | 内容 |
|---|---|
| 1 | npub1 |
| 2 | name |
| 3 | display_name |
| 4 | picture |

並び順は採用作品数の降順 (同数のときは waka.jsonl 内での初出順)。

## jsonl2tsv.sh

`waka.jsonl` を読み、`waka.tsv` (12 列, タブ区切り) を出力する。

| 列 | 内容 |
|---|---|
| 1 | フラグ (`1`) |
| 2-6 | block0..block4 (5-7-5-7-7 各句のオリジナル表記) |
| 7-11 | block0..block4 (各句の読み, 平仮名) |
| 12 | 元和歌の `note1` |

`@haiku` ボット (`tmp/nostr-haikubot/`) と同じ判定パイプラインを再現する:

1. content から NIP-08 mention `#[0]`、`nostr:` bech32 ref、`#hashtag` を除去
2. kagome (`ipa-neologd`) + `userdic.txt` でトークナイズ
3. `mattn/go-haiku` の `MatchWithOpt` と同じロジックで 5-7-5-7-7 の境界を計算
4. 各 block の表層 (オリジナル) と読み (カタカナ→ひらがな変換) を取り出す

5-7-5-7-7 にならない (現在の辞書では match しない) 行は捨てて stderr にログ。

`tools/collect-waka/blocksplit/` の Go プログラムが本処理を担当。最初の実行時に
自動 build される (`userdic.txt` のパスは `USERDIC` 環境変数で上書き可)。
