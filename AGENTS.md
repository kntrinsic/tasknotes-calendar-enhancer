# TaskNotes Calendar Enhancer (`tasknotes-calendar-enhancer`) 設計・引き継ぎガイド（AGENTS.md）

> **このファイルについて**
> このドキュメントは、既存の `TaskNotes`（`v5.0.1`）の調査結果・設計方針・セキュリティ要件・開発手順をまとめた **引き継ぎ書兼 `AGENTS.md`** です。
> 新しく作成したプラグイン用リポジトリのルート直下に **`AGENTS.md`** というファイル名で配置することで、新しいワークスペースを開いた AI エージェントがこれまでの調査文脈をそのまま引き継いで開発を開始できます。

---

## 1. このドキュメントの使い方（引き継ぎガイド）

1. 新しいローカルフォルダと **Public** GitHub リポジトリ（例：`tasknotes-calendar-enhancer`）を作成します。
2. このファイルの内容を、そのまま新リポジトリのルートに `AGENTS.md` として保存します。
3. 新しいフォルダを AI エージェントのワークスペースとして開き、最初に以下のように指示してください。

```text
AGENTS.md を読んで、まずは Phase 1（プラグインの初期プロジェクト構成、GitHub Actions CI/Release、Dependabot 設定）を作成してください。
```

> **作業上の注意（AI エージェント向け）**
> - `D:\projects\tasknotes`（TaskNotes 本体リポジトリ）は参照元であり、本プロジェクトは**完全に独立した別プラグイン**として実装する。TaskNotes 本体へパッチを当てる前提にはしない。
> - 実装・検証は必ず **テスト用の隔離された Obsidian Vault** を対象に行い、ユーザーの本番 Vault には直接ビルド成果物を置かない。
> - 以下の全セクションの制約（特にセキュリティ・プライバシー・Obsidian Bases の `#1397` 回避・`onunload` 完全クリーンアップ）を厳守すること。

---

## 2. プロジェクト概要・前提条件

### 基本情報
- **プラグイン ID（案）**: `tasknotes-calendar-enhancer`
- **表示名（案）**: `TaskNotes Calendar Enhancer`
- **目的**: TaskNotes 本体を fork せずに、日常利用で不足している以下の 3 機能をコンパニオン（拡張）プラグインとして安全に補完する。
  1. Bases ツールバー（並べ替え・フィルター等と同じヘッダー）から表示カレンダーを簡単に切り替える UI
  2. Google / Microsoft / ICS 等の外部カレンダーの起動時ローカルキャッシュ（デスクトップ・モバイル両対応で起動直後から表示）
  3. モバイル月表示（特に `chips` モードやコンパクト表示）で予定をタップして詳細を開けるようにする対応
- **配布・公開形態**:
  - GitHub **Public リポジトリ**
  - **BRAT**（Beta Reviewers Auto-update Tester）を用いてデスクトップ・モバイル両方へ配信・更新する（GitHub Releases のタグは `v` なしの `X.Y.Z` 形式、例：`0.1.0`）
- **対象 TaskNotes ベースライン**: `v5.0.1`（Obsidian Bases ビュー統合 + `@tasknotes/calendar` `0.1.12`）
- **テスト環境**: 本番 Vault とは別に新規作成した **開発テスト専用 Obsidian Vault**（コアプラグイン **Bases** およびコミュニティプラグイン **TaskNotes** が有効な状態）

### モジュール化・設定トグル方針
アップストリームの TaskNotes は開発速度が非常に速いため、将来 TaskNotes 本体側でいずれかの機能が実装・修正された場合にすぐ無効化できるよう、**プラグイン設定画面に 3 機能それぞれの独立した ON/OFF トグル**を設ける。

- `enableToolbarCalendarPicker`（デフォルト: `true`）
- `enableExternalCalendarCache`（デフォルト: `true`）
- `enableMobileMonthTap`（デフォルト: `true`）
- 設定画面に「カレンダーキャッシュを今すぐ削除（Clear calendar cache）」ボタンを配置する。

---

## 3. TaskNotes `v5.0.1` 内部構造リファレンス（調査済みファクト）

コンパニオンプラグインは公式の拡張 API ではなく TaskNotes のランタイムオブジェクトおよび Bases DOM に接続するため、以下の実コード調査結果を前提として設計する。

### 3.1 TaskNotes インスタンスへのアクセスと公開サービス
- プラグインインスタンス取得：
  ```ts
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
  const tasknotes = plugins?.["tasknotes"];
  ```
- **公式拡張 API (`plugin.api`) に関する補足**：
  TaskNotes には `src/api/runtime-api.ts` に定義された `plugin.api`（`tasks.*`, `query.*`, `time.*`, `pomodoro.*`, `extensions.register` 等）が存在するが、**カレンダー UI や外部カレンダープロバイダ（Google / Microsoft / ICS）は対象外**である。そのため `src/tasknotesBridge.ts` にランタイムアクセスを集約し、型ガードとフォールバックで防御的に扱う。
- `TaskNotesPlugin` インスタンス上の主要プロパティ（`src/main.ts`）：
  - `icsSubscriptionService`:
    - `getSubscriptions()`: `ICSSubscription[]`（`id`, `name`, `enabled`, `color`, `type` 等）
    - `getAllEvents()`: `ICSEvent[]`
    - `on("data-changed", cb)`
  - `googleCalendarService`: 現在有効な `GoogleCalendarSource`（Sign in with Google 利用中は `HostedGoogleCalendarService`、自前 OAuth 利用中は `GoogleCalendarService`）
    - `getAvailableCalendars()`: `ProviderCalendar[]`（`id`, `summary`, `primary`, `backgroundColor`, `canWrite`）
    - `getAllEvents()`: `ICSEvent[]`
    - `on("data-changed", cb)`
  - `ownGoogleCalendarService`: `GoogleCalendarService`
    - 自前 Google Cloud OAuth 接続時に利用。`googleCalendarSyncTokens` は設定に永続化されるが、イベントキャッシュはメモリのみ。起動時の初回同期は `#2243` / `#2553` 対応として強制フル同期が行われる。
  - `hostedGoogleCalendarService`: `HostedGoogleCalendarService`
    - `isSignedIn(): boolean`
    - `isConnected(): boolean`
    - `getAllCalendars()`: 表示対象外を含む全カレンダー
    - `client.getSnapshot()`: セッション・接続状態・選択済みカレンダー一覧（`selected`、最大 `MAX_SELECTED_CALENDARS` = 5 件まで選択可能）
    - `setShownCalendars(calendarIds: string[])`
    - `on("session-changed", cb)` / `on("data-changed", cb)`
  - `microsoftCalendarService`: `MicrosoftCalendarService`
    - `getAvailableCalendars()`, `getAllEvents()`, `on("data-changed", cb)`
  - `calendarProviderRegistry`: `CalendarProviderRegistry`
  - `cacheManager`: `getTaskInfo(path: string): Promise<TaskInfo | null>`
  - `openTaskEditModal(task: TaskInfo, onTaskUpdated?: () => void)`
  - `notifyDataChanged(filePath?: string, force?: boolean, triggerRefresh?: boolean)`
  - `settings`: `singleClickAction`（`"edit" | "openNote"`）, `doubleClickAction`（`"edit" | "openNote" | "none"`）, `disableCalendarOnMobile`

> **起動時の読み込みが遅い構造的背景（参考）**
> `src/bootstrap/pluginBootstrap.ts` の `initializeServicesLazily` では `ICS` → `Hosted Google` → `Own Google` → `Microsoft` の初期化が直列 `await` されており、各プロバイダ内部でもカレンダーごとに直列フェッチして全件取得後に `emit("data-changed")` する。コンパニオン側では通信処理自体には踏み込まず、キャッシュラッパーによって「前回データで即座に表示し、バックグラウンドの本体同期完了後に差し替える（Stale-While-Revalidate）」ことで体感を改善する。

### 3.2 Bases `CalendarView` へのアクセスと設定キー
- `leaf.view?.getViewType?.() === "bases"` のリーフから Bases ビューにアクセスできる：
  - `(leaf.view as any).controller?.view` がビュー実体。
  - `view.type === "tasknotesCalendar"` が通常カレンダー（ミニカレンダーは `"tasknotesMiniCalendar"`）。
- `CalendarView` の主要メンバー（`src/bases/CalendarView.ts`）：
  - `config`: `BasesViewConfig`（`get(key)`, `set(key, value)`）
  - `calendar`: `@tasknotes/calendar` の `Calendar` インスタンス（`openMore(day, target, event)`, `getView()`, `view`）
  - `calendarItems`: 描画済みイベント配列（`CalendarEventItem[]`）
  - `refetchEvents()`: イベント再構築＆再描画
  - `viewOptions`: `{ showMonthDayPanel: boolean, calendarView: string, ... }`
- **重大な注意点（Bases API バグ `#1397` 回避）**：
  - **`onunload()` の中では絶対に `config.set()` を呼ばないこと。** Bases 側の不具合により別ファイル（`.base`）の設定を破壊する恐れがある。`config.set()` はユーザーの明示的なクリック操作中などアクティブなタイミングでのみ呼ぶ。
- ビュー単位のカレンダー表示 ON/OFF 設定キー（`src/bases/calendarViewOptions.ts`）：
  - ICS: `showICS_${sub.id}`（未設定時デフォルト `true`）
  - Google: `showGoogleCalendar_${cal.id}`（未設定時デフォルト `true`。なおプライマリエイリアス `primary` に注意）
  - Microsoft: `showMicrosoftCalendar_${cal.id}`（未設定時デフォルト `true`）

### 3.3 Bases ツールバーの DOM 構造
`src/bases/basesToolbar.ts` によると、TaskNotes が扱うツールバー構造は以下の通り：
- `.bases-view` の親要素内に `.bases-toolbar` が存在する。
- Obsidian Bases 標準項目：
  - `.bases-toolbar-results-menu`
  - `.bases-toolbar-sort-menu`
  - `.bases-toolbar-filter-menu`
  - `.bases-toolbar-properties-menu`
  - `.bases-toolbar-search`
  - `.bases-toolbar-new-item-menu`
- TaskNotes が注入する要素：
  - `.tn-bases-new-task-btn`（`.bases-toolbar-new-item-menu` の直前に挿入）
  - `.tn-bases-toolbar-more`（狭い画面時に上記標準項目をポップオーバーへ退避するオーバーフローボタン）

### 3.4 月表示（`dayGridMonth`）のレスポンシブ仕様とタップ不能の原因
`CalendarView.ts` の `getMonthDisplay()` および `@tasknotes/calendar` / `styles/bases-calendar.css` の挙動は以下の 3 段階に分かれている：

1. **幅 > 850px (`monthDisplay = "full"`)**
   - イベントバー（`.tnc-dg-layer .tnc-item`）が `pointer-events: auto` で表示され、クリックで `TaskEditModal` / `ICSEventInfoModal` / `TimeblockInfoModal` が開く。
2. **幅 560px 〜 850px (`monthDisplay = "chips"`)**
   - `.tnc-dg--chips` が適用され、予定は `.tnc-dg-dots > .tnc-item--indicator` として描画される。
   - **問題点**：`@tasknotes/calendar` 側 CSS で `.tnc-dg-dots` および `.tnc-dg-dots > .tnc-item--indicator` に **`pointer-events: none`** が指定されている。TaskNotes 側は `.tnc-dg-dots-more`（`+N more`）にのみ `pointer-events: auto` を上書きしているため、デフォルト設定（`showMonthDayPanel: false`）では**チップをタップしても詳細が開かず、`+N more` が無い日はポップオーバーすら開けない**。
3. **幅 < 560px（スマホ縦画面など）**
   - `showMonthDayPanel ? "dots" : "full"`（エンジン側が狭幅時は自動で `.tnc-dg--compact` に切り替え、日付セルタップでその日の予定一覧 `.tnc-popover` を開く）。
   - タップされた要素周辺から取得できる主な DOM 属性：`data-task-path`, `data-ics-event="true"`, `data-event-type`, 祖先要素 `[data-date="YYYY-MM-DD"]`。

---

## 4. 実装する 3 機能の詳細設計

### 機能 1：Bases ツールバーへのカレンダー切り替えボタン（`src/toolbarCalendarPicker.ts`）
- **目的**：設定画面やビュー設定メニューの奥まで行かず、Sort / Filter が並ぶ `.bases-toolbar` 上のボタンから表示する外部カレンダーを即座に ON/OFF できるようにする。
- **挙動**：
  1. `workspace.on("layout-change")` / `active-leaf-change`、および必要に応じた最小限の `MutationObserver` で、表示中の `tasknotesCalendar` ビューを検出する。
  2. 該当ビューの `.bases-toolbar` 内に識別用クラス付きボタン（例：`tnce-calendar-toggle-btn`）を注入する。
     - 既存の `.tn-bases-new-task-btn` や `.tn-bases-toolbar-more` と干渉しない位置（例：`.tn-bases-new-task-btn` または `.bases-toolbar-new-item-menu` の手前、あるいは操作しやすい位置）に配置し、モバイルでも十分なタップ領域（44px 相当）を確保する。
  3. ボタン押下で、Google / Microsoft / ICS ごとにグループ化されたチェックリスト UI（Obsidian 標準の `Menu` またはアクセシブルなポップオーバー）を開く。
  4. 項目を選択すると、対象 `CalendarView` の `config.set(key, nextValue)` を実行して表示を即時更新する（必要に応じて `refetchEvents()` を呼ぶ）。
  5. Hosted Google（Sign in with Google）利用時は、TaskNotes プラグイン設定で有効化されている最大 5 件のカレンダーのみが `getAvailableCalendars()` に現れる仕様をそのまま尊重し、必要に応じて案内文や設定リンクを出す（他設定の勝手に書き換えは行わない）。
  6. ビュー切り替え時や `onunload()` 時には注入した全 DOM 要素を確実に削除する。

### 機能 2：外部カレンダーの起動時ローカルキャッシュ（`src/externalCalendarCache.ts`）
- **目的**：デスクトップ・モバイル共通で、Obsidian 起動直後の外部カレンダー読み込み待ち（空白状態）を解消する。
- **方式（Stale-While-Revalidate ラッパー）**：
  - TaskNotes 本体の内部 `private` プロパティや `refreshAllCalendars()` の通信ロジックは書き換えない（アップデート耐性を最大化するため）。
  - `ownGoogleCalendarService`, `hostedGoogleCalendarService`, `microsoftCalendarService`, `icsSubscriptionService` の **`getAllEvents()` と `getAvailableCalendars()`** を `monkey-around`（または解除可能な安全なラッパー）でラップする。
  - **起動直後（セッション内でそのプロバイダの初回同期完了前）**：デバイスローカルに保存されたキャッシュを即座に返す。
  - **初回同期完了後（各プロバイダの `"data-changed"` イベント受信後）**：ラッパーは即座に本物のメソッド結果をそのままパススルーする状態へ切り替え、最新イベント一覧・カレンダー一覧をローカルストレージに保存し直す。
  - もしキャッシュ読み込みより先に `CalendarView` が空で描画されていた場合は、`notifyDataChanged` または開いている `CalendarView.refetchEvents()` で 1 回再描画を促す。
- **保存先・データ形式・ライフサイクル**：
  - 保存先は **デバイスローカルのみ**：`app.loadLocalStorage(key)` / `app.saveLocalStorage(key, value)`（容量が肥大化する場合に備え IndexedDB へのフォールバックまたはサイズ上限・TTL 管理を検討）。**Vault 内（`.md` / `.obsidian/plugins/.../data.json` 等）には絶対に書き込まない。**
  - 保存ペイロードには `{ version, savedAt, accountFingerprint?, calendars, events }` を含め、TTL（例：7 日）と最大件数/サイズ上限を設ける。破損 JSON は握りつぶさず破棄して安全にフォールバックする。
  - **セキュリティ上の必須クリーンアップ**：
    - `hostedGoogleCalendarService` の `"session-changed"` でサインアウト／切断を検知したら即座にキャッシュ破棄。
    - `ownGoogleCalendarService` / `microsoftCalendarService` が未接続状態になったら即座にキャッシュ破棄。
    - プラグイン設定画面の「Clear calendar cache」ボタンでも全消去可能にする。
    - `onunload()` 時は必ずすべてのパッチを解除する。

### 機能 3：モバイル月表示で予定をタップして詳細表示（`src/mobileMonthTap.ts` + `styles.css`）
- **目的**：モバイルや狭い画面幅の月表示（特に `chips` モードやコンパクト表示）で、予定をタップした際にタスク詳細／外部予定詳細を確認できるようにする。
- **CSS（`styles.css`）**：
  - 機能が有効なときのみ `document.body` にトグルクラス（例：`tnce-mobile-month-tap`）を付与し、そのスコープ下で `.tnc-dg--chips .tnc-dg-dots > .tnc-item--indicator { pointer-events: auto; cursor: pointer; }` 等を有効化する。
- **インタラクション設計**：
  1. `.tnc-dg--chips` または狭幅月表示の予定インジケータがタップされた際：
     - `data-task-path` がある場合：`tasknotes.cacheManager.getTaskInfo(path)` から最新情報を取得し、TaskNotes のクリック設定（`singleClickAction`）または編集モーダル `openTaskEditModal(task)` で詳細を開く。
     - `data-ics-event="true"` 等の場合：`CalendarView.calendarItems` から該当アイテムを引くか、該当日セル `[data-date]` の日番号 `parseDay` を取得して `calendarView.calendar.openMore(day, target, event)` を呼び、詳細へアクセスできるようにする。
  2. `showMonthDayPanel` が `false` の状態で、`+N more` が存在しない日のチップ／セルをタップした場合も、その日の予定一覧ポップオーバー（`openMore`）へフォールバックできるようにする（`showMonthDayPanel: true` のときは既存の「日パネル選択」挙動を壊さない）。
  3. **既存操作との非干渉**：水平スワイプ（`calendarSwipe.ts`）、ドラッグ＆ドロップ、選択モード（`tn-selection-mode`）、通常の `full` モードでのクリック動作を妨げない。

---

## 5. セキュリティ・品質・保守性ルール（必須）

1. **依存ライブラリの最小化**：
   - ランタイム `dependencies` は **0 個、または `monkey-around` のみ** とする。外部通信ライブラリ・テレメトリ・アナリティクス・不明なサードパーティパッケージは絶対に追加しない。
2. **個人データ・予定の保護（Vault 非保存）**：
   - 外部カレンダーの予定データは **絶対に Vault 内ファイルやプラグインの `data.json` に保存しない**（Obsidian Sync / Git / iCloud 等で予定が他端末・リポジトリに意図せず同期・流出するのを防ぐため）。保存は `app.localStorage`（`app.loadLocalStorage` / `app.saveLocalStorage`）または端末ローカルの IndexedDB に限定する。
3. **認証情報の非接触**：
   - OAuth トークン、クライアントシークレット、ICS パスワード（Obsidian SecretStorage 等）の読み取り・コピー・ログ出力は一切行わない。
4. **XSS（クロスサイトスクリプティング）防止**：
   - 外部カレンダーのタイトル・説明・場所やタスク名を DOM に描画する際、**`innerHTML` / `outerHTML` / `insertAdjacentHTML` は使用禁止**。必ず `textContent` または Obsidian 標準の DOM ビルダ（`createEl`, `createDiv`, `createSpan`）を使う。
5. **TaskNotes 結合の隔離と防御的実装**：
   - TaskNotes 内部構造への参照はすべて `src/tasknotesBridge.ts` に閉じ込め、すべての境界で存在チェック・型ガード・`try/catch` を行う。TaskNotes が未導入・無効・アップデートで内部名が変わった場合でも、エラーで Obsidian 全体を落とさず該当機能のみ静かに停止（Graceful Degradation）し、必要時のみコンソール警告を出す。
6. **完全な後片付け（`onunload()`）**：
   - `onunload()` で必ずすべてのパッチ解除、注入 DOM の削除、`body` クラスの削除、イベントリスナー・Observer の破棄を行う。設定から各機能を OFF にした際も同様に即時クリーンアップすること。
7. **ログとリリース品質**：
   - イベント本文（タイトルや説明）をコンソールログに出さない。
   - `manifest.json` の `isDesktopOnly` は **`false`**（モバイル対応のため必須）。

---

## 6. リポジトリ構成・GitHub Actions・Dependabot 仕様

### 推奨ディレクトリ構成
```text
tasknotes-calendar-enhancer/
├── .github/
│   ├── dependabot.yml
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── src/
│   ├── main.ts                    # プラグイン本体・設定登録・ライフサイクル管理
│   ├── settings.ts                # 設定型・デフォルト値・SettingTab UI
│   ├── tasknotesBridge.ts         # TaskNotes ランタイム・Bases CalendarView 安全ラッパー
│   ├── toolbarCalendarPicker.ts   # 機能1: Bases ツールバーのカレンダー切替 UI
│   ├── externalCalendarCache.ts   # 機能2: 外部カレンダーローカルキャッシュ層
│   └── mobileMonthTap.ts          # 機能3: モバイル月表示タップ詳細表示
├── tests/                         # ユニットテスト（ブリッジ・キャッシュTTL/クリア・DOM注入等）
├── styles.css
├── manifest.json                  # id: "tasknotes-calendar-enhancer", isDesktopOnly: false
├── versions.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── eslint.config.mjs              # innerHTML 禁止・strict TypeScript チェック等
├── .gitignore                     # node_modules/, main.js（リリース生成物はgit管理しない）等
└── AGENTS.md                      # 本ファイル
```

### `.github/workflows/ci.yml` 要件
- トリガー：`push`（`main`）および `pull_request`
- **最小権限**：トップレベルで `permissions: contents: read`
- すべての `uses:`（`actions/checkout`, `actions/setup-node` 等）は **ブランチや短縮タグではなく完全なコミット SHA でピン留め**（例：`actions/checkout@<40桁SHA> # v4`）
- 実行ステップ：
  1. `npm ci`（`package-lock.json` を厳守、`npm install` 不可）
  2. `npm run typecheck`（`tsc --noEmit`）
  3. `npm run lint`（ESLint）
  4. `npm test`（ユニットテスト）
  5. `npm run build`（本番ビルド、`manifest.json` / `main.js` / `styles.css` 生成確認）
  6. `npm audit --audit-level=high`（脆弱性チェック）

### `.github/workflows/release.yml` 要件
- トリガー：`push.tags` で `'[0-9]+.[0-9]+.[0-9]+'`（**Obsidian / BRAT 規約に従い `v` プレフィックスなし**）
- **最小権限**：ワークフロー全体は `contents: read`、リリース作成ジョブのみ `permissions: contents: write`
- Actions はすべて完全なコミット SHA でピン留め
- タグ名と `manifest.json` の `version` が一致していることを検証してからビルドし、`softprops/action-gh-release`（SHA ピン留め）等で以下 3 ファイルをリリースアセットとして添付する：
  - `manifest.json`
  - `main.js`
  - `styles.css`

### `.github/dependabot.yml` 要件
- `npm` エコシステムと `github-actions` エコシステムの**両方**を週次（`weekly`）でチェックし、自動更新 PR を作成する設定を含める。

### GitHub リポジトリ画面でのセキュリティ設定チェックリスト（手動 1 回）
リポジトリ作成後、GitHub の `Settings -> Code security`（または `Security` タブ）で以下を有効化する：
- **Dependabot alerts**（有効化）
- **Dependabot security updates**（有効化）
- **Secret scanning** + **Push protection**（Public リポジトリでは無料利用可能、有効化推奨）

---

## 7. 初回セットアップ＆段階的な実装ロードマップ（初心者向け手順）

### 事前準備（ユーザーがローカル・GitHub で行う作業）
1. **GitHub に新しい Public リポジトリを作成**（例：`tasknotes-calendar-enhancer`）。
2. ローカル PC にクローンまたは新規フォルダ作成（例：`D:\projects\tasknotes-calendar-enhancer`）。
3. このドキュメントを `D:\projects\tasknotes-calendar-enhancer\AGENTS.md` として配置。
4. **開発テスト用の空の Obsidian Vault を作成**（普段の Vault とは別フォルダにする）：
   - Obsidian で「新しい保管庫を作成」し、設定 → コアプラグインで **Bases** を有効化。
   - コミュニティプラグインから **TaskNotes**（`v5.0.1` 以降）をインストール・有効化し、テスト用データやカレンダー連携で動作確認できる状態にする。
5. `D:\projects\tasknotes-calendar-enhancer` をワークスペースとして開き、AI エージェントと開発を進める。

### 開発フェーズ（順番に 1 つずつ進める）
- **Phase 1：最小スケルトン & CI/CD & セキュリティ基盤**
  - `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `eslint.config.mjs`, `.gitignore`, `.github/`（CI / Release / Dependabot）を構築。
  - 空のプラグインとしてテスト Vault の `.obsidian/plugins/tasknotes-calendar-enhancer/` にビルド出力（`manifest.json`, `main.js`, `styles.css`）を配置し、Obsidian で有効化できることを確認する。
- **Phase 2：機能 1（Bases ツールバーのカレンダー切替ボタン）**
  - `src/tasknotesBridge.ts` と `src/toolbarCalendarPicker.ts` を実装。
  - デスクトップと狭幅（モバイル幅）の両方で、Sort / Filter 付近からの表示切替・オーバーフロー時の動作を確認する。
- **Phase 3：機能 3（モバイル月表示タップで詳細を開く）**
  - `src/mobileMonthTap.ts` と `styles.css` を実装。
  - Obsidian ウィンドウ幅を 560〜850px および 560px 未満にして、`chips` / `compact` 両方で予定タップから詳細モーダルまたは予定一覧が開くこと、スワイプや `showMonthDayPanel: true` が壊れないことを確認する。
- **Phase 4：機能 2（外部カレンダーの起動時ローカルキャッシュ）**
  - `src/externalCalendarCache.ts` を実装。
  - 起動直後にキャッシュから即表示され、バックグラウンド同期後に最新データへ入れ替わること、設定のクリアボタンおよびサインアウト時にキャッシュが消去されることを確認する。
- **Phase 5：リリース＆BRAT 導入**
  - `manifest.json` / `versions.json` を `0.1.0` にして GitHub へ push し、タグ `0.1.0` を作成・push。
  - GitHub Actions の `release.yml` が `manifest.json`, `main.js`, `styles.css` の 3 ファイルをリリースに添付したことを確認。
  - 本番の Obsidian（デスクトップ・モバイル）にコミュニティプラグイン **BRAT** を入れ、「Add Beta plugin」から作成した Public リポジトリ URL を登録して利用開始する。

---

### 参考：アップストリーム（TaskNotes）へ並行して出すべき Issue
本プラグインで当面を快適にしつつ、並行して `https://github.com/callumalpass/tasknotes/issues` に以下を報告・提案しておくと、将来的に本体の正式修正を取り込んで拡張プラグイン側をシンプルにできる。

1. **Bug（優先度高）**：月表示の `chips` モード（ペイン幅 560〜850px・`showMonthDayPanel: false`）で `.tnc-item--indicator` が `pointer-events: none` のため予定をタップして詳細を開けず、`+N more` がない日はポップオーバーも開けない問題。
2. **Enhancement**：起動時の外部カレンダー初期化（ICS / Google / Microsoft）およびプロバイダ内複数カレンダー取得の並列化＋ローカルキャッシュ対応（Vault 非保存のデバイスローカルキャッシュ）。
3. **Enhancement**：Bases ツールバー（またはカレンダー上部）へのクイックカレンダー切り替えボタン追加。
