# Personal NAS runtime candidate

初回Cloud準備用。実NASには未導入。`deploy/nas-backup` の汎用backup clientとは別。

- Linux amd64の隔離builderで `pnpm install --frozen-lockfile` 後、固定Node image digestと検証済みageを入力する。Windowsのnode_modulesをコピーしてbuildしない。
- Docker contextはallowlistでcode/locked dependencies/private migrationsとsynthetic testsを含む。Git、work、実runtime設定、鍵、Cloudflare/Wrangler設定は含めない。runtime stageにはtests/config/proposalsを含めない。
- `compose.verify.yaml` はnetworkなし、rootfs read-only、非root、capabilityなし、host mountなし。作業先はtmpfs。ageの試験鍵だけをtmpfs内で生成する。
- CIでbuildするのは `verify` target。本番候補は同じDockerfileの `runtime` targetを承認済みbuilderでbuildし、最終image ID/digestとSBOM/依存inventoryを別途固定する。registryへpublishする手順や自動deployはない。デフォルト実行はplanで、networkなし。
- `scripts/personal-nas-runner.mjs` はsourceごとの排他と既存の契約/transport/custody検査を通る。Linuxでは `/usr/bin/flock` とNAS内部local filesystemが必要。SMB/NFSの再共有をrootにしない。
- kernel lockの `cycle.flock` は常設inode。削除しない。旧 `cycle.lock` / `reap.lock` があれば、旧clientの停止/影響確認なしで自動移行しない。
- read-only codeに対し、`/app/work` はコンパイルと一時復元用tmpfs。backup rootのみ永続化。実credential/age identityはbackup rootとは別のread-only file mountとし、実UID/GIDで読める0600相当を確認する。
- rootfs、network制約、PID上限、crypto/復元のsynthetic成功はTOS実機のACL・容量・鍵回復・scheduler受入を代替しない。

TOS提案ではruntimeのcontainer内pathを `root=/data`, `age_binary=/usr/local/bin/age`, `s3_credentials_file=/run/credentials/r2.json`, `restore_identity_file=/run/credentials/age-identity.txt` に対応させる。これらはcontainer内の配置案であり、NAS hostの実pathは未確定。実configは承認後に別ファイルで作成し、Gitへ入れない。

検証ではCLI plan/disabled拒否、独立client同時起動、プロセスSIGKILL後の自動復旧、初回/日次のsynthetic暗号化・復号・復元・取消し・期限処理を確認する。TOS側では加えて2つのone-shotコンテナを同じ専用rootへ向けた排他と再起動を受け入れる。
