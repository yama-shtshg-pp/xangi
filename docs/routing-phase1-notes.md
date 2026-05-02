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
