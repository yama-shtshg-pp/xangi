// pm2 プロセス定義（ローカル常駐用）
//
// 適用: pm2 delete xangi-my-cc-company && pm2 start ecosystem.config.cjs && pm2 save
//
// 2026-08-29: node_modules 消失で起動直後クラッシュ → 再起動を 4997 回繰り返し、
// 10MB×14 本のログを生成した。min_uptime / max_restarts で早期に errored へ落とす。
const fs = require('node:fs');

// bash の場所は環境で異なる（Homebrew arm64 / intel / システム標準）
const BASH = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'].find((p) =>
  fs.existsSync(p)
);

module.exports = {
  apps: [
    {
      name: 'xangi-my-cc-company',
      script: BASH,
      args: ['-c', 'npm start'],
      interpreter: 'none',
      cwd: __dirname,

      autorestart: true,
      // 起動から 30 秒持たずに落ちたら「起動失敗」とみなす
      min_uptime: '30s',
      // 起動失敗が 10 回続いたら再起動をやめて errored で停止する
      max_restarts: 10,
      // 即時リトライを避けてログ肥大とCPU浪費を抑える
      restart_delay: 5000,

      merge_logs: true,
      time: true,
    },
  ],
};
