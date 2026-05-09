# ツール

`tools/` 配下のスクリプトとデータの関係。

```mermaid
flowchart TD
  relays[nostr リレー群]:::data
  jsonl[waka.jsonl]:::data
  userdic[tmp/nostr-haikubot/userdic.txt]:::data
  wakatsv[waka.tsv]:::data
  datawaka[data/waka.tsv]:::data
  authortsv[data/author.tsv]:::data
  ranking[ランキング stdout]:::data

  collect[collect-waka.sh]
  jsonl2tsv[jsonl2tsv.sh]
  manual[人力チェック]
  authorsh[author-statistics.sh]

  relays --> collect --> jsonl
  jsonl --> jsonl2tsv
  userdic --> jsonl2tsv
  jsonl2tsv --> wakatsv
  wakatsv --> manual --> datawaka
  jsonl --> authorsh
  datawaka --> authorsh
  relays --> authorsh
  authorsh --> authortsv
  authorsh --> ranking

  classDef data fill:none,stroke:none
```

## スクリプト

| スクリプト | 役割 |
|---|---|
| `collect-waka/collect-waka.sh` | `@haiku` ボットの kind:10002 が指す全リレーから `#n57577` を含む kind:1 を since/until ページングで全件取得し `waka.jsonl` に保存 |
| `collect-waka/jsonl2tsv.sh` | `waka.jsonl` を読み、`@haiku` と同じ kagome (ipa-neologd) + `userdic.txt` で 5-7-5-7-7 に分割し読み (平仮名) と note1 を付けて `waka.tsv` (12 列) を出力 (内部で `blocksplit/` の Go バイナリを呼ぶ) |
| `collect-waka/author-statistics.sh` | `waka.jsonl` から元和歌の author を集計してランキングを stdout に出力。さらに `data/waka.tsv` (flag=1) に対応する author の kind:0 を取得し `data/author.tsv` (npub1, name, display_name, picture) を出力 |

## 人力チェック

`waka.tsv` の 1 列目フラグを `1` (採用) / `0` (不採用) に編集し、`data/waka.tsv` として保存する。
