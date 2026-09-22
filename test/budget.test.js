import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Budget } from '../server/budget.js';

test('两个进程共用账本时不会互相覆盖，预算按合计计算', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'budget-')), 'usage.json');
  const web = new Budget(file, 0.01);
  const arena = new Budget(file, 0.01);
  web.record('jev', { inputTokens: 100, costUsd: 0.004 });
  await new Promise((r) => setTimeout(r, 20)); // 让文件修改时间前进
  arena.record('jev', { inputTokens: 100, costUsd: 0.004 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Math.round(web.snapshot().spent_usd * 1e6), 8000, '网页服务能看到 arena 的花费');
  assert.equal(web.snapshot().by_backend.jev.requests, 2);
  assert.equal(web.reserve(0.003), false, '合计 0.008 + 0.003 超过 0.01 上限');
  assert.equal(web.reserve(0.001), true);
  const fresh = new Budget(file, 0.01);
  assert.equal(Math.round(fresh.spent * 1e6), 8000, '重启后账本不清零');
});
