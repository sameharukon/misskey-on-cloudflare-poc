# ローカル連合テスト環境

misskey-cf を 2 つ（`https://a.mk.test` と `https://b.mk.test`）ローカルで起動し、その間で連合の動作を確かめるためのスクリプトです。さらに、upstream の Misskey（`https://m.mk.test`）と Mastodon（`https://t.mk.test`、`AUTHORIZED_FETCH=true`）を Docker で起動し、実装の異なるサーバーとの相互運用も確かめられます。

## 構成

| 要素 | 内容 |
|------|------|
| DB | ローカル PostgreSQL の `mk_a` / `mk_b`（`pnpm db:migrate up` で同梱 migration を適用、`meta` は `federation: all`・登録可） |
| Workers | 環境ごとに 1 つの `wrangler dev` プロセスで gateway / api / stream / timeline を実行（`--persist-to .fed-local/state-<env>` で DO・Queue を分離） |
| 設定 | `gen-config.mjs` が各 `wrangler.toml` から `wrangler.fed-<env>.toml` を生成（gitignore）。Worker 名に `mkfed-<env>-` を付け、`INSTANCE_URL` とローカル Postgres の `localConnectionString` を差し替える |
| media | Cloudflare Container の代わりに、`packages/media-container` のサーバー（sharp + ffmpeg）をホストの :8090 で起動し、`media-shim.ts`（転送だけの Worker）を `MEDIA` に割り当てる。サムネイル、blurhash、`/proxy` が本番と同じ処理で動く。`FED_NO_MEDIA=1` で外せる |
| HTTPS | `tls-proxy.mjs` が :443 で TLS を終端し、Host ごとに `wrangler dev`（8701 / 8702）へ転送。自己署名 CA をシステムの信頼ストアに入れ、`/etc/hosts` で 2 ホストを 127.0.0.1 に向ける |

`.test` ドメインは SSRF ガード（`safe-fetch.ts`）の対象外なので、本番と同じ https・署名付き GET・Queue 経由の配送で動きます。`wrangler dev` には `--local-upstream <host> --upstream-protocol https` を付け、Worker から見た `request.url` を本番と同じ `https://<host>/…` にしています。

## 使い方

root 権限（:443 の bind、`/etc/hosts`、CA の登録）と、`postgres:postgres@127.0.0.1:5432` で接続できる PostgreSQL が必要です（`PG_URL_BASE` で変更可）。最初に `pnpm install` を実行してください。

```bash
bash scripts/fed-local/fed-local.sh setup   # DB 作成・migration・meta、TLS 証明書、/etc/hosts（初回のみ）
bash scripts/fed-local/fed-local.sh up      # 2 環境と HTTPS フロントを起動し、root アカウントを作成
bash scripts/fed-local/fed-local.sh smoke   # 連合スモークテスト（結果は .fed-local/report.md）
bash scripts/fed-local/fed-local.sh down    # 停止
bash scripts/fed-local/fed-local.sh reset   # 停止して DB とローカル状態を削除
```

- root アカウント: `admin` / `pass-a-123`（A）、`admin` / `pass-b-123`（B）。セットアップパスワードは `setup-a` / `setup-b`
- ログ: `.fed-local/logs/{a,b,tls,media}.log`。Worker の `console.log` は wrangler の観測用エンドポイントで SQL を使って読めます（`curl -X POST http://127.0.0.1:8701/cdn-cgi/local/explorer/api/local/observability/query -H 'content-type: application/json' -d '{"sql":"SELECT level, message FROM logs ORDER BY ts_ms DESC LIMIT 50"}'`）
- `FED_ONLY=<正規表現>` で一部の項目だけ実行でき、`FED_TIMEOUT_MS` で 1 つの反映を待つ時間を変更できます（既定 60 秒）。後の項目は前の項目の状態（フォローなど）に依存します
- ユーザーは実行ごとに接尾辞付きで作るため、同じ DB で繰り返し実行できます。サインインはレート制限（1 時間に 10 回）があるため、スモークテストは root のトークンを DB から読みます

## スモークテストの項目

`smoke.mjs` は、一方でクライアント API を呼び、もう一方でその効果を待ちます。

- ディスカバリ: WebFinger（双方向）、host-meta、NodeInfo、`/@user` から Actor へのリダイレクト
- Actor: 相互解決（instance actor の署名付き GET）、Person のプロフィール（name / bio / fields / isCat）
- フォロー: 双方向、鍵アカウントの承認・拒否、Undo Follow、followers ページ、非公開の followers が 403
- ノート: CW・ハッシュタグ、メンション通知、リプライ、引用、リノートと Undo Announce、リアクション（双方向と取り消し）、公開範囲 home / followers / specified、投票（Question、リモートからの投票、Update(Question)）、featured（ピン留め）、outbox、`ap/show`、Delete(Note)
- アカウント: Update(Person)、ブロック、添付ファイル（Document と `remoteFile` ジョブ）、引っ越し（Move とフォロワー移行）、アカウント削除（Delete(Person)）
- ゲート: `blockedHosts`、`federation: none` で WebFinger / AP GET が 403

## Misskey / Mastodon との相互運用（`remotes.sh`）

`remotes.sh` は upstream の Misskey（`misskey/misskey:2026.10.0`）と Mastodon（`tootsuite/mastodon:v4.7.3`）、ActivityPub リレー（`yukimochi/activity-relay:v2.0.11`、`https://relay.mk.test`）を Docker で起動します。どちらもホストのネットワークで動き、DB は同じローカル PostgreSQL（`mk_misskey` / `mk_mastodon`）、Redis はそれぞれのコンテナ（6390 / 6391）です。HTTPS は `fed-local.sh` の TLS プロキシが 4 ホスト分をまとめて終端します。

```bash
dockerd > /tmp/dockerd.log 2>&1 &              # Docker デーモン（このコンテナでは手動で起動）
bash scripts/fed-local/fed-local.sh setup        # 証明書に m / t を含める（既存の証明書は作り直す）
bash scripts/fed-local/fed-local.sh up
bash scripts/fed-local/remotes.sh setup          # DB、Mastodon のスキーマと秘密値、起動、テストユーザーとトークン
bash scripts/fed-local/fed-local.sh smoke-remotes            # 両方（結果は .fed-local/report-remotes.md）
bash scripts/fed-local/fed-local.sh smoke-remotes mastodon   # 片方だけ
bash scripts/fed-local/remotes.sh down                       # 停止（reset で DB と秘密値も削除）
```

- テストユーザーは両方とも `admin` と `carol`（パスワード `fedtest-pass-123`）。API トークンは `.fed-local/remotes/tokens.env` に書き出します（gitignore）
- この環境に合わせた設定:
  - Misskey は `cacheable-lookup` で DNS を直接引き `/etc/hosts` を読まないため、`dns.mjs`（`*.mk.test` だけに答える最小の DNS サーバー）をコンテナの唯一のネームサーバーにしています
  - 127.0.0.1 への接続を、Misskey は `allowedPrivateNetworks`、Mastodon は `ALLOWED_PRIVATE_ADDRESSES` で許可しています
  - upstream Misskey の `meta.federation` は初期値が `none` なので、セットアップで `all` にしています
  - Mastodon のアカウントは、メールの MX 確認（DNS が必要）を避けるため rails runner で作ります。Mastodon に API のない操作（別名、引っ越し、アカウント削除）は `remotes.sh rails '<Ruby>'` で行います
  - カスタム絵文字は、misskey-cf の `fed_a` と Misskey の `fed_m` をテストが API で登録し、Mastodon の `fed_t` は `remotes.sh setup` が登録します
  - リレーはフォローを自動で承認します（activity-relay の既定）。公開リレーは使いません
- Docker Hub は匿名の pull に回数制限があるため、`remotes.sh` は手元にないイメージだけを取得します。ghcr.io はこの環境のネットワークの方針で取得できないため、Mastodon は Docker Hub のイメージを使います

`smoke-remotes.mjs` は、次の 34 項目を Misskey と Mastodon のそれぞれに対して実行し、最後に環境全体の 6 項目を実行します（計 74 項目）。サーバーごとの API の違いはアダプターで吸収しています。

- ディスカバリ: 相互の解決（Mastodon は `AUTHORIZED_FETCH` のため instance actor の署名付き GET）、相手の連合サーバー一覧（Misskey は `federation/show-instance`、Mastodon は `instance/peers`）
- Actor: Person の name / bio / fields（Misskey は isCat も）、アイコン（双方向）、Update(Person) の双方向
- フォロー: 双方向、鍵アカウントの承認・拒否、Undo Follow、ブロック（双方向）
- ノート（こちらから）: CW・ハッシュタグ、メンション通知、公開範囲（Mastodon では unlisted / private / direct として届く）、リプライ、引用、リノートと取り消し、添付ファイル、投票（相手の投票と Update(Question)）、カスタム絵文字、featured のピン留めと解除、削除
- ノート（相手から）: CW・ハッシュタグ・メンション通知（`hashtag` の集計も）、リプライ、引用、ブーストと取り消し、添付ファイル（`remoteFile` で md5 と blurhash が埋まる）、投票（こちらの投票が相手で数えられる）、カスタム絵文字、削除
- リアクション: 双方向と取り消し（Mastodon ではお気に入り）、カスタム絵文字のリアクション
- アカウント: 引っ越し（Move）の双方向とフォロワーの移行、Delete(Person) の双方向（こちらの削除は、upstream と同じくフォロー関係から知っている shared inbox へ送る）
- 環境全体: `signToActivityPubGet: false` で無署名の GET になる（Mastodon は拒否、Misskey は応答）、`cacheRemoteFiles` で R2 にキャッシュしてサムネイルを作る、`blockedHosts`（配送側）、`federation: specified`（受信・配送の両方）、`isNotResponding`（Misskey のコンテナを止めて立ち、再開後の配送で外れる）、リレー（misskey-cf ↔ リレー ↔ Misskey の双方向、LD 署名）

### upstream 側の制限（テストで確認した、upstream と同じ挙動）

- Mastodon の引用仕様（FEP-044f）には、upstream Misskey と同じく対応していません。こちらの引用は Mastodon では `RE: <リンク>` 付きの通常の投稿として表示され、Mastodon からこちらのノートを引用しようとすると Mastodon 側が拒否します
- Mastodon には絵文字リアクションがないため、こちらのカスタム絵文字のリアクションはお気に入りとして数えられます
- upstream Misskey 2026.10.0 は、リモートのアカウントが Misskey のローカルアカウントへ引っ越すと、フォロワーを移行できません（`processRemoteMove` が移動先を `uri` 列で引き、ローカルユーザーでは NULL のため失敗します）。`movedTo` は記録されます。テストはこのケースで `movedTo` までを確かめます
- upstream Misskey は、リレー経由（LD 署名）の Update(Person) を JSON-LD で compaction するため、fields が 1 つだけだと配列でなくなり、fields が空になります（`analyzeAttachments` は配列のみ扱う）。Misskey 同士でも同じです
- upstream Misskey はリレーの一覧を 10 分間キャッシュします。テストはリレーの項目を Misskey を再起動する `isNotResponding` の後に置いています
- Mastodon は Actor の JSON を 3 分間キャッシュします（更新しても破棄しない）。misskey-cf は upstream と同じく Update(Person) に埋め込まれた Actor を使い、Update で処理済みの Move では Actor を取り直しません
- upstream の JSON-LD コンテキストには `movedTo` がないため、引っ越した Person の Update をリレーへ LD 署名付きで送ると署名に失敗します（upstream も同じ）

## テストの相手

他人が運営する Misskey / Mastodon / リレーは、テストの相手にしません（検索・フォロー・投稿・リレー登録を含む）。相互運用の確認は、この環境（upstream のイメージを Docker で動かす）か、自分で管理するドメインに立てたテスト用のインスタンスで行います。足りない相手（リレーなど）は、この環境に追加して確かめます。

## この環境で確かめられないこと

- 実ドメインでのデプロイ後の相互運用（本番の `INSTANCE_URL` と `meta.federation`、Cloudflare 上の Queue）
- Cloudflare Container としての media（ローカルでは同じサーバーをホストで直接動かしている）
- Cloudflare 本番の Queue 挙動（リトライ間隔、複数 isolate 間のキャッシュ）
