# ルーティング Phase 1 — 運用観察メモ

## Phase 1 でやったこと（要約）

- `src/router.ts` 追加。エラー検知 regex でメッセージを `'opus'` に振り分け
- `src/dynamic-runner.ts` の `run()` / `runStream()` 冒頭で判定。
  発火時のみ ad-hoc な non-persistent `ClaudeCodeRunner` を spawn
- 発火しないメッセージは `AGENT_MODEL` 環境変数（現状: `haiku`）のデフォルト経路へ
- Discord チャンネルトピックから JSON 振り分けプロンプトを削除

実装は **regex 前段 1 段のみ**。自己エスカレーション・model 別セッション継続は Phase 2 として保留。

## ルーティングログ

ルート発火時のみ stdout に以下が出る：

```
[dynamic-runner] Routed to opus (ad-hoc, no session)
[dynamic-runner] Routed to opus (ad-hoc stream, no session)
```

非発火時はログなし。発火頻度・誤判定の調査は基本このログを追えばよい。

## 観察すべきポイント

### 1. 誤判定の頻度

regex は荒い前段なので両方向で誤りうる。

- **過剰発火**（Opus 不要だったが回った）
  - 例：「テスト失敗してるけど期待通り？」のような雑談文
  - コスト的に痛いが品質劣化はない
  - 許容ラインの目安：週 5 件以上なら regex 修正検討
- **漏れ**（本当のエラーが Haiku に流れて雑処理された）
  - こちらの方が損失大（再質問の手間が発生）
  - 起きたケースは regex に追加すべき語を控えておく

### 2. Opus 消費量

`AGENT_MODEL=haiku` 前提で運用しているので、Opus 消費はルート発火時のみ。

- 確認方法：Anthropic コンソール / Claude Code の使用量ダッシュボード
- 警戒ライン：週次で予算を超える勢いなら、regex を絞る or Phase 2（escalation で間引き）検討

### 3. 追問時の文脈ロスト

Phase 1 は **発火時にセッションを毎回新規発行**する設計（本流チャンネルセッションを保護するため）。

シナリオ：
1. ユーザー：エラー貼る → Opus で単発回答（新規セッション）
2. ユーザー：「もっと詳しく」「修正案を実装して」← regex 非ヒット → Haiku（本流セッション）に流れる
3. Haiku 側は Opus が見たエラー文脈を持っていないので、ユーザーが再度説明する手間が発生

- 体感メモ：起きた回数 / どの程度ストレスだったか / そのまま続けて使えたか
- 頻発するなら Phase 2（model 別セッション継続）の優先度が上がる

## Phase 2 検討トリガ（目安）

下記のいずれかが 1〜2 週間の運用で観測されたら Phase 2 を検討：

- 追問の文脈ロストが週 3 回以上発生し、毎回 Opus に貼り直している
- Opus 消費量が予算を圧迫
- regex 誤判定（過剰・漏れ合算）が週 10 件以上で運用感に影響

## 参考：regex の現状

`src/router.ts`

```
/Error|Exception|Traceback|エラー|失敗|落ちる|動かない|スタックトレース/i
```

追加したい語が出てきたらここを編集。

## Jev による判定の shadow 検証

regex の代わりに Jev（TypeSafe System One）で振り分けられるかを、本番の振り分けを変えずに確かめる。
Issue #9 で進めている。

### 有効にする

```
JEV_ROUTING=shadow
TYPESAFE_API_KEY=<TypeSafe の API キー>
```

- `JEV_ROUTING` の既定は `off`。`on` はまだ使えず、指定しても `off` として扱う
- 振り分けは従来どおり regex が決める。Jev の呼び出しは待たないので、応答時間は変わらない
- タイムアウトは 800ms。キー未設定・タイムアウト・API エラーは `error` に残し、処理は続ける
- regex による振り分けの対象（claude-code バックエンドで、実効 model が opus 以外）だけを判定する

### Jev に聞いていること

1 回の呼び出しで、次の 2 つを並列に聞いている。質問文は `src/router.ts` にある。

- `effort`（Choice）: 依頼に必要な処理の重さ
  - `light` → `haiku`、`normal` → `sonnet`、`hard` → `opus` に対応付ける
- `followup`（Noul）: 直前の回答への追問か
  - regex が Opus に振り分けて答えた直後のメッセージ（30 分以内）だけで聞く
  - state には直前の依頼と Opus の回答を入れる

### ログ

`DATA_DIR/logs/jev-routing.jsonl`（`DATA_DIR` の既定は `WORKSPACE_PATH/.xangi`）に 1 メッセージ 1 行で残る。

| フィールド | 内容 |
| --- | --- |
| `timestamp` | 判定した時刻 |
| `channel` | チャンネル ID |
| `prompt` | メッセージの先頭 100 文字 |
| `regex` | regex の結果（`opus` / `default`） |
| `default_model` | regex が発火しないときに使う model |
| `jev` / `jev_effort` | Jev が選んだ model と処理の重さ |
| `confidence` / `probabilities` | `effort` の確信度と、選択肢ごとの確率 |
| `has_previous` / `followup` | 追問判定をしたか、追問である確率 |
| `latency_ms` | Jev の応答時間 |
| `error` | 失敗したときの理由 |
| `jev_model` | 応答した Jev のバージョン |

食い違いの洗い出しには、たとえば次のように使う。

```
jq -c 'select(.error == null and ((.regex == "opus") != (.jev == "opus")))' jev-routing.jsonl
```
