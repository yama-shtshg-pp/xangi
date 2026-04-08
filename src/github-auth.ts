/**
 * GitHub App認証
 *
 * GitHub App設定があれば gh ラッパースクリプトを自動生成し、
 * エージェントの PATH に差し込む。gh 実行時に毎回トークンを生成。
 * 設定がなければ既存の gh 認証をそのまま使用。
 */
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join, dirname } from 'path';

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

let appConfig: GitHubAppConfig | null = null;

// ラッパースクリプトの配置先
const WRAPPER_DIR = '/tmp/xangi-gh-wrapper';
const WRAPPER_PATH = join(WRAPPER_DIR, 'gh');

// トークン生成スクリプト
const TOKEN_SCRIPT_PATH = join(WRAPPER_DIR, 'generate-token.cjs');

/**
 * GitHub App設定を初期化しラッパーを生成
 */
export function initGitHubAuth(): void {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (appId && installationId && privateKeyPath) {
    // Docker環境ではマウント先の固定パスを使用
    const dockerPemPath = '/secrets/github-app.pem';
    const resolvedKeyPath = existsSync(dockerPemPath) ? dockerPemPath : privateKeyPath;
    appConfig = { appId, installationId, privateKeyPath: resolvedKeyPath };
    generateWrapper(appConfig);
    console.log(`[github-auth] GitHub App mode enabled (App ID: ${appId})`);
  } else {
    console.log('[github-auth] Using default gh authentication');
  }
}

/**
 * GitHub App が有効かどうか
 */
export function isGitHubAppEnabled(): boolean {
  return appConfig !== null;
}

/**
 * エージェントの PATH に追加すべきディレクトリ
 * App モード: ラッパーディレクトリを返す
 * 通常モード: undefined
 */
export function getGitHubWrapperDir(): string | undefined {
  return appConfig ? WRAPPER_DIR : undefined;
}

/**
 * エージェントプロセスに渡す環境変数を取得
 * App モード: PATH にラッパーディレクトリを先頭追加
 * 通常モード: 空オブジェクト
 */
export function getGitHubEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string> {
  if (!appConfig) return {};
  const currentPath = baseEnv['PATH'] || process.env.PATH || '';
  return { PATH: `${WRAPPER_DIR}:${currentPath}` };
}

/**
 * ラッパースクリプトとトークン生成スクリプトを生成
 */
function generateWrapper(config: GitHubAppConfig): void {
  mkdirSync(WRAPPER_DIR, { recursive: true });

  // Node.js トークン生成スクリプト（CommonJS形式、@octokit/auth-app使用）
  const tokenScript = `const { createAppAuth } = require('@octokit/auth-app');
const { readFileSync } = require('fs');
(async () => {
  const auth = createAppAuth({
    appId: '${config.appId}',
    privateKey: readFileSync('${config.privateKeyPath}', 'utf-8'),
    installationId: ${config.installationId},
  });
  const { token } = await auth({ type: 'installation' });
  process.stdout.write(token);
})();
`;
  writeFileSync(TOKEN_SCRIPT_PATH, tokenScript, 'utf-8');

  // gh ラッパーシェルスクリプト
  // CJS形式なのでNODE_PATHでnode_modulesを参照
  const xangiDir = join(dirname(new URL(import.meta.url).pathname), '..');
  const wrapper = `#!/bin/bash
export GH_TOKEN="$(NODE_PATH="${xangiDir}/node_modules" node "${TOKEN_SCRIPT_PATH}")"
if [ -z "$GH_TOKEN" ]; then
  echo "Error: Failed to generate GitHub App token" >&2
  exit 1
fi
echo "[github-auth] Using GitHub App token (App ID: ${config.appId})" >&2
exec "$(which -a gh | grep -v "${WRAPPER_DIR}" | head -1)" "$@"
`;
  writeFileSync(WRAPPER_PATH, wrapper, 'utf-8');
  chmodSync(WRAPPER_PATH, 0o755);
}
