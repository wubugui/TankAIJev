import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

// 付费后端的花费账本：持久化到磁盘，重启不清零。
// 网页服务和 arena 可能同时运行、共用同一个账本文件，所以每次预扣/记账前都会
// 重新读取磁盘上的最新值（按修改时间判断），记账后立即写盘。
// 发请求前按保守估算预扣检查，超出上限直接拒绝；返回后按实际 usage 记账。
export class Budget {
  constructor(file, limitUsd) {
    this.file = file;
    this.limitUsd = limitUsd;
    this.data = { spent_usd: 0, by_backend: {} };
    this.mtime = null;
    this.reserved = 0; // 本进程内正在进行中的请求的预估花费
    this.refresh();
  }

  refresh() {
    try {
      const { mtimeMs } = statSync(this.file);
      if (mtimeMs === this.mtime) return;
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof saved.spent_usd === 'number') this.data = { spent_usd: saved.spent_usd, by_backend: saved.by_backend || {} };
      this.mtime = mtimeMs;
    } catch {
      // 还没有账本文件，或正被另一个进程写入：沿用内存里的值
    }
  }

  get spent() { this.refresh(); return this.data.spent_usd; }
  get remaining() { return Math.max(0, this.limitUsd - this.spent - this.reserved); }

  // 预留一笔估算花费；不够就返回 false
  reserve(estimateUsd) {
    this.refresh();
    if (this.data.spent_usd + this.reserved + estimateUsd > this.limitUsd) return false;
    this.reserved += estimateUsd;
    return true;
  }

  release(estimateUsd) {
    this.reserved = Math.max(0, this.reserved - estimateUsd);
  }

  record(backendId, { inputTokens = 0, outputTokens = 0, costUsd = 0, ok = true }) {
    this.refresh();
    const b = (this.data.by_backend[backendId] ||= { requests: 0, errors: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    b.requests++;
    if (!ok) b.errors++;
    b.input_tokens += inputTokens;
    b.output_tokens += outputTokens;
    b.cost_usd += costUsd;
    this.data.spent_usd += costUsd;
    this.saveNow();
  }

  saveNow() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify({ ...this.data, limit_usd: this.limitUsd, updated_at: new Date().toISOString() }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, this.file);
    } catch {
      // Windows 上目标文件正被另一个进程读取时 rename 可能失败，退回直接写
      writeFileSync(this.file, text);
    }
    try { this.mtime = statSync(this.file).mtimeMs; } catch { /* 忽略 */ }
  }

  snapshot() {
    this.refresh();
    return {
      limit_usd: this.limitUsd,
      spent_usd: round6(this.data.spent_usd),
      remaining_usd: round6(Math.max(0, this.limitUsd - this.data.spent_usd - this.reserved)),
      by_backend: Object.fromEntries(Object.entries(this.data.by_backend).map(([k, v]) => [k, { ...v, cost_usd: round6(v.cost_usd) }])),
    };
  }
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// 保守估算输入 token：按 3 个字符 1 个 token，再加上服务端固定开销
export function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body).length / 3) + 400;
}
