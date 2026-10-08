# 使い方ガイド

xangiの詳細な使い方ガイドです。

## 目次

- [基本操作](#基本操作)
- [チャンネルトピック注入](#チャンネルトピック注入)
- [タイムスタンプ注入](#タイムスタンプ注入)
- [セッション管理](#セッション管理)
- [スケジューラー](#スケジューラー)
- [GitHub issue からの起動](#github-issue-からの起動)
- [Discordコマンド](#discordコマンド)
- [コマンドプレフィックス](#コマンドプレフィックス)
- [ランタイム設定](#ランタイム設定)
- [AIによる自律操作](#aiによる自律操作)
- [Standaloneモード](#standaloneモード)
- [Docker実行](#docker実行)
- [Local LLM（Ollama）](#local-llmollama)
- [トラブルシューティング](#トラブルシューティング)

## 基本操作

### メンションで呼び出し

```
@xangi 質問内容
```

### 専用チャンネル

`AUTO_REPLY_CHANNELS` に設定したチャンネルではメンション不要で応答します。

## チャンネルトピック注入

Discordチャンネルのトピック（概要）が設定されている場合、その内容がプロンプトに自動注入されます。

チャンネルごとに異なるコンテキストや指示をAIに渡すことができます。

### 設定方法

Discordのチャンネル設定 → 「トピック」に自然言語で指示を記述します。

### 活用例

- `作業前に必ず ~/project/README.md を読むこと`
- `このチャンネルでは日本語で返答すること`
- `常にmemory-RAGを検索してから返答すること`

トピックが空の場合は何も注入されません。

## タイムスタンプ注入

プロンプトの先頭に現在時刻（JST）を自動注入します。AIが時間経過を認識でき、経過時間の把握や時間に関連する判断が正確になります。

デフォルトで有効です。無効にするには：

```bash
INJECT_TIMESTAMP=false
```

注入フォーマット: `[現在時刻: 2026/3/8 12:34:56]`

## セッション管理

| コマンド                    | 説明                   |
| --------------------------- | ---------------------- |
| `/new`, `!new`, `new`       | 新しいセッションを開始 |
| `/clear`, `!clear`, `clear` | セッション履歴をクリア |

### Discordボタン操作

応答メッセージにボタンが表示されます。

- **処理中**: `Stop` ボタン — `/stop` と同等。タスクを中断
- **完了後**: `New` ボタン — `/new` と同等。セッションをリセット

`DISCORD_SHOW_BUTTONS=false` でボタンを非表示にできます。

### 危険コマンドの承認フロー

エージェントが危険なコマンドを実行しようとすると、Discordにボタン付きの確認メッセージが表示されます。

```
⚠️ 危険なコマンドを検知
git push origin main
Git push

[許可] [拒否]
```

- 2分以内に応答がなければ自動拒否
- Claude Code / Local LLM 両バックエンド対応
- 承認サーバー（`localhost:18181`）で統一管理

**検知対象コマンド:**

| カテゴリ | パターン | 説明 |
|---------|---------|------|
| ファイル削除 | `rm -r`, `rm -f` | 再帰的・強制削除 |
| Git | `git push` | リモートへのpush |
| Git | `git reset --hard` | 変更の破棄 |
| Git | `git clean -f` | 未追跡ファイル削除 |
| Git | `git branch -D` | ブランチ強制削除 |
| 権限 | `chmod 777` | 全権限付与 |
| 権限 | `chown -R` | 再帰的所有権変更 |
| システム | `shutdown`, `reboot` | システム停止・再起動 |
| システム | `kill -9`, `killall` | プロセス強制終了 |
| リモート実行 | `curl \| sh`, `wget \| bash` | リモートスクリプト実行 |
| DB | `DROP TABLE`, `TRUNCATE` | データベース削除 |
| 機密ファイル | `cat .env`, `cat *.pem` | 認証情報の読み取り |
| 機密ファイル | Write/Editで `.env`, `.pem`, `credentials` を変更 | 認証情報の変更 |

**Claude Codeバックエンドの設定:**

ワークスペースの `.claude/settings.json` にPreToolUseフックを追加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18181/hooks/pre-tool-use",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**Local LLMバックエンド:** 設定不要。自動的に承認サーバーに問い合わせます。

## スケジューラー

定期実行やリマインダーを設定できます。AIが自然言語を解釈して `!schedule` コマンドを自動実行します。

### コマンド一覧

| コマンド                        | 説明                                 |
| ------------------------------- | ------------------------------------ |
| `/schedule`                     | スラッシュコマンドでスケジュール操作 |
| `!schedule <時間> <メッセージ>` | スケジュール追加                     |
| `!schedule list` / `!schedule`  | 一覧表示（全チャンネル）             |
| `!schedule remove <番号>`       | 削除（複数可: `remove 1 2 3`）       |
| `!schedule toggle <番号>`       | 有効/無効切り替え                    |

> 💡 `/schedule` スラッシュコマンドでも同様の操作ができます。

### 時間指定の書き方

#### 単発リマインダー

```
30分後 〇〇をリマインド
1時間後 会議の準備
15:30 今日の15時半に通知
```

#### 繰り返し（自然言語）

```
毎日 9:00 朝の挨拶
毎日 18:00 日報を書く
毎週月曜 10:00 週次レポート
毎週金曜 17:00 週末の予定確認
```

#### cron式

より細かい制御が必要な場合はcron式も使えます：

```
0 9 * * * 毎日9時
0 */2 * * * 2時間ごと
30 8 * * 1-5 平日8:30
0 0 1 * * 毎月1日
```

| フィールド | 値   | 説明                |
| ---------- | ---- | ------------------- |
| 分         | 0-59 |                     |
| 時         | 0-23 |                     |
| 日         | 1-31 |                     |
| 月         | 1-12 |                     |
| 曜日       | 0-6  | 0=日曜, 1=月曜, ... |

### CLI（コマンドライン）

```bash
# スケジュール追加
npx tsx src/schedule-cli.ts add --channel <channelId> "毎日 9:00 おはよう"

# 一覧表示
npx tsx src/schedule-cli.ts list

# 削除（番号指定）
npx tsx src/schedule-cli.ts remove --channel <channelId> 1

# 複数削除
npx tsx src/schedule-cli.ts remove --channel <channelId> 1 2 3

# 有効/無効切り替え
npx tsx src/schedule-cli.ts toggle --channel <channelId> 1
```

### データ保存

スケジュールデータは `${DATA_DIR}/schedules.json` に保存されます。

- デフォルト: `/workspace/.xangi/schedules.json`
- 環境変数 `DATA_DIR` で変更可能

## GitHub issue からの起動

指定したリポジトリに `agent` ラベルの付いた issue があると、xangi が tmux の中で対話モードの Claude Code を起動します。
チャットで話しかけなくても、issue をきっかけに動きます。
xangi が受け持つのは起動までです。起動したあとのやり取りは、人が Claude Code と直接行います。

### 設定

```bash
EVENTS_ENABLED=true
EVENT_NOTIFY_CHANNEL_ID=123456789012345678
```

対象のリポジトリは、`DATA_DIR/watch-repos.json`（ウォッチリスト）に手元のパスで並べます。

```json
{
  "repos": [
    { "path": "~/git_tmp/my-xangi" },
    { "path": "~/git_tmp/some-fork", "remote": "upstream" },
    { "path": "~/git_tmp/keiba-note", "label": "bot", "enabled": false }
  ]
}
```

- xangi は `gh issue list` で、open で対象のラベル（既定は `agent`）の付いた issue を 5 分ごとに取ります
  - `gh` は xangi を動かしているユーザーの認証をそのまま使います
  - Webhook は使わないので、マシンを外部に公開する必要はありません
- 起動・終了・失敗はログに出ます
  - Discord が有効で `EVENT_NOTIFY_CHANNEL_ID` があれば、そのチャンネルにも通知します

### ウォッチリスト

項目ごとに次の値を書けます。

| 項目 | 説明 | 省略時 |
|---|---|---|
| `path` | 手元のリポジトリ（必須）。`~` を展開します。絶対パスか `~` で始めます | - |
| `remote` | GitHub のリポジトリ名を読み取る remote | `origin` |
| `repo` | `owner/repo`。書くと remote から読み取らずにこの値を使います | remote から読み取る |
| `label` | 起動の対象にするラベル | `EVENT_GITHUB_LABEL` |
| `notifyChannelId` | 起動・終了・失敗の通知先 | `EVENT_NOTIFY_CHANNEL_ID` |
| `enabled` | `false` にするとポーリングしません | `true` |

- Claude Code は項目の `path` で起動します。そのリポジトリの `CLAUDE.md` や品質ゲートが最初から効きます
- GitHub のリポジトリ名は、`git -C <path> remote get-url <remote>` の URL から読み取ります
  - HTTPS（`https://github.com/owner/repo.git`）と SSH（`git@github.com:owner/repo.git`）に対応します
  - `git@github-sub:owner/repo.git` のような SSH の別名ホストでも読み取れます
  - フォークのように remote が複数あるときは、issue を立てる側を `remote` か `repo` で指定します
- xangi はポーリングのたびにファイルを読み直します。追加・削除・無効化に再起動は要りません
  - xangi の起動時にファイルがなく、`EVENT_GITHUB_REPOS` も空のときは、イベントからの起動が無効になります。あとからファイルを作ったら、xangi を再起動してください
- ファイルが読めないときや JSON の形式がおかしいときは、そのポーリングを飛ばしてログに残します
  - 前回読めた内容でも動かしません。JSON の形式エラーはログに行と列を出します
- 次の項目は飛ばし、Discord に 1 回だけ通知します。直したあとにまた同じ問題が起きたら、もう一度通知します
  - `path` が存在しない、または git リポジトリでない
  - remote がない、または URL から `owner/repo` を読み取れない
  - 前の項目と同じリポジトリを指している

ウォッチリストがなく `EVENT_GITHUB_REPOS` があるときは、従来どおり `EVENT_GITHUB_REPOS` のリポジトリをポーリングします。
このとき Claude Code の作業ディレクトリは xangi のワークスペースです。
両方あるときはウォッチリストを使い、`EVENT_GITHUB_REPOS` を無視することを起動時にログに出します。

### チャットなしで動かす

Discord・Slack・Web チャットを設定しなくても、イベント源だけで xangi を起動できます。
既存の Bot と同じトークンを使うと同じメッセージに 2 つのインスタンスが返事をするので、イベント専用のインスタンスはチャットを設定せずに動かします。

```bash
EVENTS_ENABLED=true
# 対象のリポジトリは DATA_DIR/watch-repos.json に並べる
# DISCORD_TOKEN / SLACK_* / WEB_CHAT_ENABLED は設定しない
# claude が PATH にないときだけ指定する
# EVENT_CLAUDE_PATH=/Users/you/.local/bin/claude
```

- Discord が無効なときは、承認サーバーを起動しません。ほかのインスタンスとポートを取り合いません
  - ワークスペースの Claude Code の設定に、承認サーバーへの PreToolUse フックを入れないでください。許可の確認は Claude Code 本体が出します
- `claude` か `tmux` が見つからないときは、イベントからの起動を止めます
  - チャットも無効なら、xangi はエラーで終了します
- `claude` はエイリアスを通さず、絶対パスで起動します
  - シェルのエイリアスに `--dangerously-skip-permissions` を入れていても、許可の確認はいつもどおり出ます

### 起動のしかた

issue ごとに、次の名前で tmux のセッションを作り、Claude Code を起動します。

```bash
tmux new-session -d -s cc-<リポジトリ名>-issue<番号> -c <作業ディレクトリ> -- \
  claude -n cc-<リポジトリ名>-issue<番号> --remote-control cc-<リポジトリ名>-issue<番号> "<issue の内容>"
```

- セッション名の中で tmux が使えない文字（`.` や `:`）は `-` に置き換えます
- issue の内容は最初のプロンプトとして渡します。シェルは通さないので、本文の `$()` などは実行されません
- 作業ディレクトリは、ウォッチリストの項目の `path` です
  - `EVENT_GITHUB_REPOS` で動かしているときは、xangi のワークスペース（`WORKSPACE_PATH`）です
  - Claude Code に信頼済みのフォルダにしておいてください。信頼の確認が出ると、そこで止まります
  - 作業ディレクトリは issue を受け付けたときの値を使います。受け付けたあとにウォッチリストを変えても、待っている issue の起動先は変わりません
- セッションの PATH は xangi のものを使います。GitHub App 認証を使っていれば、`gh` はアプリの権限で動きます
- `TMUX_TMPDIR` は xangi に設定されている値を使います。手元の tmux と同じ値にしておかないと、`tmux attach` でセッションが見つかりません
- 許可の確認と入力待ちの通知は、Claude Code の Remote Control とプッシュ通知に任せます

起動したセッションには、tmux でつなぐか、スマホなどの Remote Control からセッション名（例 `cc-xangi-issue14`）を選んでつなぎます。

```bash
tmux attach -t cc-xangi-issue14
```

### 起動のルール

- 同じ issue では 1 回しか起動しません。ラベルを付け直しても、xangi を再起動しても同じです
- tmux のセッションがある間は起動中、なくなったら終了として記録します
  - 作業が終わったかどうかは判定しません。セッションを閉じたら終了とみなします
  - xangi はポーリングのたびに、起動中のセッションがあるかを確かめます
- 同じ名前の tmux セッションがすでにあれば起動せず、起動しなかったと記録して通知します
  - セッション名にオーナーは入らないので、オーナーが違う同じ名前のリポジトリの同じ番号の issue は、後から来たほうが起動しません
- 起動して数秒のうちに claude が終了したら、起動に失敗したと記録します
  - 認証エラーなどの内容は残らないので、ワークスペースで `claude` を手で起動して確かめてください
- 1 分間の load average を CPU コア数で割った値が `EVENT_MAX_LOAD` を超えている間は起動しません
  - そのあいだ issue はキューで待ち、負荷が下がったあとのポーリングで古い順に起動します
- 同時に起動するのは `EVENT_MAX_CONCURRENT` 件までです。起動中のセッションの数で数えます
- xangi を再起動したとき、セッションが残っていれば起動中のまま扱います。なければ終了にします

### 注意

- `agent` ラベルを付けられるのは、リポジトリの triage 以上の権限を持つ人だけです
  - ラベルを付ける前に、issue の本文が自動で実行させてよい内容かを確かめてください
- 閉じ忘れたセッションは残り続け、同時起動数を使います。終わったら閉じてください

### データ保存

受け付けた issue と状態は `${DATA_DIR}/events.json` に保存されます。

- このファイルが読めないときは、GitHub issue からの起動を止めてログに出します（Discord が有効なら通知もします）
  - 空の記録から始めると、ラベルの付いた issue をすべて起動し直してしまうためです
  - ファイルを直すか、消してよいと確かめてから xangi を再起動してください

## Discord操作（xangi-cmd）

AIが `xangi-cmd` CLIツール経由でDiscord操作を実行します。xangi内蔵のtool-server（HTTP API）を介するため、DISCORD_TOKEN等のシークレットはAI CLIからアクセスできません。

| コマンド | 説明 |
|----------|------|
| `xangi-cmd discord_history --channel <ID> [--count N] [--offset M]` | チャンネル履歴取得 |
| `xangi-cmd discord_send --channel <ID> --message "text"` | メッセージ送信 |
| `xangi-cmd discord_channels --guild <ID>` | チャンネル一覧 |
| `xangi-cmd discord_search --channel <ID> --keyword "text"` | メッセージ検索 |
| `xangi-cmd discord_edit --channel <ID> --message-id <ID> --content "text"` | メッセージ編集 |
| `xangi-cmd discord_delete --channel <ID> --message-id <ID>` | メッセージ削除 |
| `xangi-cmd media_send --channel <ID> --file /path/to/file` | ファイル送信 |

### 使用例

```bash
# チャンネル履歴を取得
xangi-cmd discord_history --count 10
xangi-cmd discord_history --channel 1234567890 --count 10
xangi-cmd discord_history --channel 1234567890 --count 30 --offset 30  # 遡り

# 別チャンネルにメッセージ送信
xangi-cmd discord_send --channel 1234567890 --message "作業完了しました！"

# チャンネル一覧
xangi-cmd discord_channels --guild 9876543210

# メッセージ検索
xangi-cmd discord_search --channel 1234567890 --keyword "PR"
```

`--channel` を省略した場合、xangi上で実行中なら現在のチャンネルIDが使われます。CLI単体実行では `--channel` が必要です。

```bash
# メッセージ編集・削除
xangi-cmd discord_edit --channel 1234567890 --message-id 111222333 --content "修正後の内容"
xangi-cmd discord_delete --channel 1234567890 --message-id 111222333
```

### Tool Server

xangi-cmdはxangiプロセス内のtool-server（HTTP API）に中継します。

- ポートはOS自動割り当て（複数インスタンスでも競合なし）
- xangi本体が起動時に `XANGI_TOOL_SERVER` を子プロセスへ注入
- `xangi-cmd` は `XANGI_TOOL_SERVER` を使って接続先を解決
- 現在のチャンネルIDなど、xangi実行時の文脈は `context` としてtool-serverに引き渡されます

## 許可確認のスキップ

デフォルトではAIはファイル作成やコマンド実行時に許可確認を求めます。
`!skip` プレフィックスまたは `/skip` スラッシュコマンドで許可確認をスキップできます。

環境変数 `SKIP_PERMISSIONS=true` を設定すると、デフォルトで全メッセージがスキップモードになります。

### `!skip` プレフィックス

メッセージの先頭に `!skip` を付けると、そのメッセージだけスキップモードで実行します。

### `/skip` スラッシュコマンド

`/skip メッセージ` で、許可確認をスキップしてメッセージを実行します。`!skip` プレフィックスと同じ動作です。

### 使用例

```
@xangi !skip gh pr list
!skip ビルドして                    # 専用チャンネルではメンション不要
/skip ビルドして                    # スラッシュコマンド版
```

## ランタイム設定

`${WORKSPACE_PATH}/settings.json` にランタイム設定が保存されます。

```json
{
  "autoRestart": true
}
```

| 設定          | 説明                             | デフォルト |
| ------------- | -------------------------------- | ---------- |
| `autoRestart` | AIエージェントによる再起動を許可 | `true`     |

### 設定の確認・変更

| コマンド    | 説明             |
| ----------- | ---------------- |
| `/settings` | 現在の設定を表示 |
| `/restart`  | ボットを再起動   |

### バックエンド動的切り替え

チャンネルごとにバックエンド・モデル・effortレベルを切り替えられます。

| コマンド                                          | 説明                                   |
| ------------------------------------------------- | -------------------------------------- |
| `/backend show`                                   | 現在のバックエンド・モデルを表示       |
| `/backend set claude-code`                        | Claude Codeに切り替え                  |
| `/backend set local-llm --model nemotron-3-nano`  | Local LLM + モデル指定                 |
| `/backend set claude-code --effort high`          | effort指定付きで切り替え               |
| `/backend reset`                                  | デフォルト（.env設定）に戻す           |
| `/backend list`                                   | 利用可能なバックエンド・モデル一覧     |

切り替え時は自動的に新しいセッションが開始されます（会話履歴は引き継がれません）。

#### 環境変数で制限

```bash
# 切り替え許可バックエンド（未設定=切り替え不可）
ALLOWED_BACKENDS=claude-code,local-llm

# 切り替え許可モデル（未設定=制限なし）
ALLOWED_MODELS=nemotron-3-nano,nemotron-3-super,qwen3.5:9b

# チャンネル別バックエンド設定（JSON）
CHANNEL_OVERRIDES={"チャンネルID":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### 永続化

`/backend set` で変更した設定は `.env` の `CHANNEL_OVERRIDES` に自動保存されます。再起動後も設定が維持されます。

Docker環境では `.env` はコンテナ外にあるため、AI（Claude Code等）から変更されることはありません。

#### effort オプション（Claude Code用）

Claude Code の `--effort` オプション（`low` / `medium` / `high` / `max`）をチャンネルごとに設定可能。persistent モードではプロセス再起動が必要なため、切り替え時にセッションがリセットされます。`/backend set claude-code --effort デフォルト` で未指定状態に戻せます。

## AIによる自律操作

### 設定変更（ローカル実行時のみ）

AIは `.env` ファイルを編集して設定を変更できます：

```
「このチャンネルでも応答して」
→ AIが AUTO_REPLY_CHANNELS を編集 → 再起動
```

### システムコマンド

AIが出力する特殊コマンド：

| コマンド                 | 説明           |
| ------------------------ | -------------- |
| `SYSTEM_COMMAND:restart` | ボットを再起動 |

### メッセージ分割セパレータ

AIの応答テキストに `\n===\n`（前後に改行を含む `===`）が含まれている場合、そこで分割して別メッセージとして送信します。スケジューラー経由の応答だけでなく、Discordメンションからの直接メッセージでも機能します。1回のLLM応答で複数の独立した投稿を生成したい場合に便利です。

```
📝 ツイート解説1
> ツイート本文...

===
📝 ツイート解説2
> ツイート本文...
```

上記の応答はDiscordに2つの別メッセージとして送信されます。

### 再起動の仕組み

- **Docker**: `restart: always` により自動復帰
- **ローカル**: pm2等のプロセスマネージャが必要

```bash
# pm2での運用例
pm2 start "npm start" --name xangi
pm2 logs xangi
```

### pm2で環境変数を変更する場合

xangiは `node --env-file=.env` で環境変数を読み込みます。環境変数を変更したい場合は **`.env` ファイルを編集してから `pm2 restart`** してください。

```bash
# 正しい方法: .envを編集してrestart
vim .env  # TIMEOUT_MS=60000 を追加
pm2 restart xangi
```

> **⚠️ `pm2 restart --update-env` は使わないこと！**
> `--update-env` はシェルの全環境変数をpm2に保存します。複数のxangiインスタンスを動かしている場合、別インスタンスの `DISCORD_TOKEN` 等が混入し、同じbotトークンで二重ログインする原因になります。
> `node --env-file=.env` は既存の環境変数を上書きしないため、pm2が先にセットした値が優先されてしまいます。

## Standaloneモード

Docker環境があれば、ワンコマンドでAIアシスタントを起動できます。Discord/Slackのトークン不要。ローカルLLM（Ollama）+ WebチャットUIで動作します。

### セットアップ

```bash
git clone https://github.com/karaage0703/xangi.git
cd xangi
./quickstart.sh
```

ブラウザで `http://localhost:18888` にアクセスしてチャットを開始。

### 仕組み

- **Ollama** — ローカルLLMサーバー（gemma4:e4b を初回起動時に自動ダウンロード）
- **xangi** — AIアシスタント（WebチャットUI付き）
- **[ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)** — ワークスペース（AGENTS.md・スキル・メモリ）

### モデル変更

```bash
LOCAL_LLM_MODEL=gemma4:26b ./quickstart.sh
```

### 停止

```bash
docker compose -f docker-compose.standalone.yml down
```

### ワークスペースの永続化

ワークスペースはホストの`workspace/`ディレクトリにマウントされます。コンテナを停止・削除してもデータは保持されます。`workspace/`内のファイルを直接編集・git pushすることも可能です。

## Docker実行

コンテナ隔離環境で実行できます。3つのコンテナが用意されています：

| コンテナ | Dockerfile | 用途 |
|---|---|---|
| `xangi` | `Dockerfile` | 軽量版（Claude Code / Codex / Gemini CLI） |
| `xangi-max` | `Dockerfile.max` | フル版（uv + Python対応、Local LLM向け） |
| `xangi-gpu` | `Dockerfile.gpu` | GPU版（CUDA + PyTorch、画像生成・音声処理向け） |

### Claude Code バックエンド

```bash
docker compose up xangi -d --build

# Claude Code 認証
docker exec -it xangi claude
```

### Local LLM バックエンド（Ollama）

Ollamaコンテナが同梱されているため、ホストにOllamaをインストールする必要はありません。

```bash
# .env を設定
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=nemotron-3-nano

# 起動（ollama + xangi-max）
docker compose up xangi-max -d --build
```

### GPU版（CUDA + Python + PyTorch）

PyTorch（CUDA対応）が利用可能で、DGX Spark（ARM64）でも動作します。

```bash
# 起動（xangi-gpu + ollama）
docker compose up xangi-gpu -d --build

# Claude Code 認証
docker exec -it xangi-gpu claude

# GPU確認
docker exec -it xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **💡 ヒント**: `xangi-gpu` は `xangi-max` の上位互換です。GPU/PyTorchが必要なスキル（音声文字起こし、画像生成等）を使う場合はこちらを選択してください。

### Docker操作

```bash
# 停止
docker compose down

# 再起動（.env変更後など）
docker compose up xangi-max -d --force-recreate

# ログ確認
docker logs -f xangi-max
```

### ワークスペースのマウント

| 環境 | 変数 | 説明 |
|---|---|---|
| ローカル | `WORKSPACE_PATH` | エージェントが直接使うパス |
| Docker | `XANGI_WORKSPACE` | ホスト側のパス（コンテナ内は `/workspace` に固定） |

Docker実行時は `.env` に `XANGI_WORKSPACE` を設定します：

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **⚠️ `WORKSPACE_PATH` は使わないこと。** ホストのシェル環境変数と衝突する可能性があります。

### セキュリティ

- コンテナはホストネットワークに**直接アクセスできません**
- Ollamaコンテナは同じdocker network内で隔離
- AIエージェントへの環境変数はホワイトリスト方式で制限（`DISCORD_TOKEN` 等はアクセス不可）

## Local LLM（Ollama）

xangiのLocal LLMバックエンドはOpenAI互換API（`/v1/chat/completions`）を使用します。

### ローカル実行（Ollama）

```bash
# .env を設定
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # デフォルト
```

Ollamaが起動していればそのまま動作します。

全バックエンドでセッション単位のトランスクリプトログ（`logs/sessions/<appSessionId>.jsonl`）が保存されます。プロンプト・応答・エラーがセッションごとのJSONLファイルに記録されます。

Docker実行については [Docker実行](#docker実行) セクションを参照してください。

### 機能の個別制御

Local LLMの各機能は環境変数で個別にon/offできます。

```bash
# .env — 例: ツールだけ無効にする
LOCAL_LLM_TOOLS=false

# 例: 雑談ボット（全部off）
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false

# 例: トリガー付き雑談
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false
LOCAL_LLM_TRIGGERS=true
```

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LOCAL_LLM_TOOLS` | ツール実行（exec/read/web_fetch） | `true` |
| `LOCAL_LLM_SKILLS` | スキル一覧注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | トリガー（!コマンド） | `false` |

`LOCAL_LLM_MODE` でプリセットも使えます（個別設定が優先）：
- `agent`（デフォルト）— 全部on
- `chat` — 全部off
- `lite` — triggers=true、他はoff

ワークスペースコンテキスト（AGENTS.md等）はどの設定でも注入されます。

### Triggers（カスタムツール）

ワークスペースの `triggers/` ディレクトリにシェルスクリプトを置くだけで、LLMが使えるカスタムツールを追加できます。`LOCAL_LLM_TRIGGERS=true` で有効化。

LLMがfunction callingでトリガーを呼び出し、handler.shを実行して結果を返します。

#### セットアップ

ワークスペースに `triggers/` ディレクトリを作成し、コマンドごとにサブディレクトリを配置します。

```
workspace/
  triggers/
    weather/
      trigger.yaml    # トリガー定義
      handler.sh      # 実行スクリプト
    search/
      trigger.yaml
      handler.sh
```

#### trigger.yaml フォーマット

```yaml
name: weather
description: "天気予報を取得する（例: weather 名古屋）"
handler: handler.sh
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `name` | Yes | ツール名（LLMがfunction callingで呼ぶ名前） |
| `description` | No | ツールの説明（LLMに渡されるツール定義に含まれる） |
| `handler` | Yes | 実行スクリプトのファイル名 |

#### handler の仕様

- ワークスペースルートを `cwd` として `bash handler.sh [引数...]` で実行
- 引数はLLMがfunction callingで渡した`args`をスペース区切りで渡す
- タイムアウト: `EXEC_TIMEOUT_MS`（デフォルト120秒）
- `stdout` の内容がLLMに返され、LLMが自然な文章で応答を生成

#### 動作フロー

1. xangi起動時にワークスペースの `triggers/` をスキャンしてツール定義を自動生成
2. LLMにカスタムツールとして登録
3. LLMがfunction callingでツールを呼び出し
4. handler.shが実行され、結果がLLMに返される
5. LLMが結果を踏まえて自然な文章で応答

#### 注意事項

- ツールが有効なモード（lite/agent）で動作します
- 新しいトリガーを追加したらxangiを再起動してください

### マルチモーダル（画像入力）

Local LLMバックエンドは画像入力に対応しています。Discord/Slackで画像を添付してメッセージを送ると、画像の内容をLLMに渡して分析・説明を求めることができます。

#### 対応画像形式

JPEG (.jpg, .jpeg)、PNG (.png)、GIF (.gif)、WebP (.webp)

#### 対応LLMサーバー

- **Ollama** — `/api/chat` の `images` フィールド（base64形式）で画像を送信
- **OpenAI互換API（vLLM等）** — `messages[].content` を配列形式（`text` + `image_url`）で送信

エンドポイントのURLにポート `11434` または `ollama` が含まれる場合はOllama形式、それ以外はOpenAI互換形式が使用されます。

#### 使用例

```
@xangi この画像について説明して
（画像を添付）
```

画像以外のファイル（PDF、テキスト等）は従来通りファイルパスとしてプロンプトに渡されます。

#### 注意事項

- マルチモーダル対応モデル（例: `llava`, `llama3.2-vision` 等）が必要です
- 画像はbase64エンコードしてそのまま送信されます（リサイズなし）
- 画像がない場合は従来通りテキストのみで動作します（後方互換性あり）

### セッション管理と自動リトライ

Local LLMバックエンドはチャンネルごとにセッション（会話履歴）を保持します。コンテキスト長超過や不正メッセージ形式などセッション履歴に起因するエラーが発生した場合、自動的にセッションをクリアして最後のユーザーメッセージだけでリトライします。

### エラーハンドリング

| エラー | メッセージ |
|--------|-----------|
| ECONNREFUSED / fetch failed | LLMサーバーに接続できませんでした。サーバーが起動しているか確認してください。 |
| timeout / aborted | LLMからの応答がタイムアウトしました。しばらくしてから再試行してください。 |
| 401 / 403 | LLMサーバーへの認証に失敗しました。APIキーを確認してください。 |
| 429 | LLMサーバーのレートリミットに達しました。しばらくしてから再試行してください。 |
| 500 / 502 / 503 | LLMサーバーで内部エラーが発生しました。しばらくしてから再試行してください。 |
| その他 | LLMエラー: （元のエラーメッセージ） |

### 対応モデル例

| モデル | サイズ | 特徴 | 備考 |
|--------|--------|------|------|
| `gpt-oss:20b` | 13GB | MoE、高品質・ツールコール対応 | 推奨 |
| `gpt-oss:120b` | 65GB | MoE（アクティブ12B）、最高品質 | 大容量メモリ必要 |
| `nemotron-3-nano` | 24GB | Mambaハイブリッド、高速 | |
| `nemotron-3-super` | 86GB | Mambaハイブリッド、高精度 | 大容量メモリ必要 |
| `qwen3.5:9b` | 6.6GB | 軽量・Thinking対応 | |
| `Qwen3.5-27B-FP8` | 29GB | ツールコール高精度、約6tok/s | vLLM推奨 |

その他Ollama/vLLMで利用可能なモデルに対応しています。

## セキュリティ

### 環境変数のホワイトリスト

AIエージェント（CLI spawn / Local LLM exec）に渡す環境変数は `src/safe-env.ts` で管理。ホワイトリストに記載された変数のみ渡され、`DISCORD_TOKEN` 等のシークレットはAIからアクセス不可。

**許可される変数:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

**渡されない変数（例）:** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

ホワイトリストを変更する場合は `src/safe-env.ts` の `ALLOWED_ENV_KEYS` を編集。

## 環境変数一覧

### Discord

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `DISCORD_TOKEN` | Discord Bot Token | **必須** |
| `DISCORD_ALLOWED_USER` | 許可ユーザーID（カンマ区切りで複数可、`*`で全員許可） | **必須** |
| `AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID（カンマ区切り） | - |
| `DISCORD_STREAMING` | ストリーミング出力 | `true` |
| `DISCORD_SHOW_THINKING` | 思考過程を表示 | `true` |
| `INJECT_CHANNEL_TOPIC` | チャンネルトピックをプロンプトに注入 | `true` |
| `INJECT_TIMESTAMP` | 現在時刻をプロンプトに注入 | `true` |

### AIエージェント

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `AGENT_BACKEND` | バックエンド（`claude-code` / `codex` / `gemini` / `local-llm`） | `claude-code` |
| `AGENT_MODEL` | 使用するモデル | - |
| `WORKSPACE_PATH` | 作業ディレクトリ（ローカル実行時） | `./workspace` |
| `XANGI_WORKSPACE` | ワークスペースのホスト側パス（Docker実行時） | `./workspace` |
| `SKIP_PERMISSIONS` | デフォルトで許可スキップ | `false` |
| `TIMEOUT_MS` | タイムアウト（ミリ秒） | `300000` |
| `PERSISTENT_MODE` | 常駐プロセスモード | `true` |
| `MAX_PROCESSES` | 同時実行プロセス数の上限 | `10` |
| `IDLE_TIMEOUT_MS` | アイドルプロセスの自動終了時間 | `1800000` |
| `DATA_DIR` | データ保存ディレクトリ（スケジュール・セッション等） | `WORKSPACE_PATH/.xangi` |
| `JEV_ROUTING` | Jev によるルーティング判定（`off` / `shadow`）。詳細は [routing-phase1-notes.md](routing-phase1-notes.md) | `off` |
| `TYPESAFE_API_KEY` | TypeSafe（Jev）の API キー。AI CLI には渡さない | - |
| `GH_TOKEN` | GitHub CLIトークン | - |

### GitHub issue からの起動

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `EVENTS_ENABLED` | GitHub issue からの起動を有効にする | `false` |
| `EVENT_GITHUB_REPOS` | 対象のリポジトリ（カンマ区切り、`owner/repo`）。`DATA_DIR/watch-repos.json` がないときだけ使う | - |
| `EVENT_GITHUB_LABEL` | 起動の対象にするラベル（ウォッチリストの `label` の既定値） | `agent` |
| `EVENT_POLL_INTERVAL_SEC` | ポーリングの間隔（秒） | `300` |
| `EVENT_MAX_LOAD` | 起動してよい負荷の上限（1 分間の load average ÷ CPU コア数） | `0.8` |
| `EVENT_MAX_CONCURRENT` | 同時に起動する数の上限 | `1` |
| `EVENT_NOTIFY_CHANNEL_ID` | 起動・終了・失敗を通知する Discord チャンネル（ウォッチリストの `notifyChannelId` の既定値） | - |
| `EVENT_CLAUDE_PATH` | イベントから起動する `claude` のパス | PATH から探す |

### GitHub App認証（オプション）

GitHub App設定があれば、`gh` CLI実行時にインストールトークンを自動生成。PATや `gh auth login` が不要に。

| 変数 | 説明 |
|------|------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | インストールID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 秘密鍵ファイルパス |

設定しなければ従来の `gh` 認証（`gh auth login` / `GH_TOKEN`）をそのまま使用。

**Docker環境:** 秘密鍵は `/secrets/github-app.pem` に自動マウントされます。`.env` にはホスト側のパスを設定してください。

**セキュリティ:** トークン生成に失敗した場合、PATへのフォールバックは行わずエラーになります。`gh` 実行時にツール表示に `🔑App` バッジが表示されます。

### Local LLM（`AGENT_BACKEND=local-llm` 時）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LOCAL_LLM_BASE_URL` | LLMサーバーURL | `http://localhost:11434` |
| `LOCAL_LLM_MODE` | プリセット（`agent` / `chat` / `lite`） | `agent` |
| `LOCAL_LLM_TOOLS` | ツール実行 | `true` |
| `LOCAL_LLM_SKILLS` | スキル一覧注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | トリガー（!コマンド） | `false` |
| `LOCAL_LLM_MODEL` | 使用するモデル名 | - |
| `LOCAL_LLM_API_KEY` | APIキー（vLLM等で必要な場合） | - |
| `LOCAL_LLM_THINKING` | Thinkingモデルの推論を有効にするか | `true` |
| `LOCAL_LLM_MAX_TOKENS` | 最大トークン数 | `8192` |
| `LOCAL_LLM_NUM_CTX` | コンテキストウィンドウサイズ（Ollama用） | モデルのデフォルト |
| `EXEC_TIMEOUT_MS` | execツールのタイムアウト（ミリ秒） | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetchツールのタイムアウト（ミリ秒） | `15000` |

### Slack

| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-...） |
| `SLACK_ALLOWED_USER` | 許可ユーザーID |
| `SLACK_AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID |
| `SLACK_REPLY_IN_THREAD` | スレッド返信するか（デフォルト: `true`） |

## トラブルシューティング

### 「Prompt is too long」エラー

**症状:** 特定のチャンネルで全てのメッセージに対して「❌ エラーが発生しました: Prompt is too long」と返される。

**原因:** セッションの会話履歴がClaude Code（Agent SDK）のコンテキスト上限を超えた。通常はAgent SDKが自動でコンテキストを圧縮するが、セッションが異常終了した場合など、状態が壊れて回復できなくなることがある。

**対処法:**

1. 該当チャンネルで `/new` コマンドを実行してセッションをリセットする
2. それでも解消しない場合は、xangiを再起動する（`pm2 restart xangi`）
