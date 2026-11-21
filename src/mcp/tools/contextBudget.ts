export interface BudgetItem {
  path: string;
  tokens: number;
  reason?: string;
  timestamp: number;
}

export interface BudgetInfo {
  totalBudget: number;
  usedTokens: number;
  remainingTokens: number;
  overBudget: boolean;
  exceededTokens: number;
  items: BudgetItem[];
}

export class ContextBudgetTracker {
  private totalBudget: number;
  private usedTokens: number = 0;
  private overflowTokens: number = 0;
  private items: BudgetItem[] = [];

  constructor(totalBudget: number = 30000) {
    this.totalBudget = totalBudget;
  }

  setBudget(totalBudget: number): void {
    this.totalBudget = totalBudget;
  }

  recordTokens(filePath: string, tokens: number, reason?: string): void {
    const newUsed = this.usedTokens + tokens;
    this.overflowTokens += Math.max(0, newUsed - this.totalBudget);
    this.usedTokens = Math.min(this.totalBudget, newUsed);
    this.items.push({
      path: filePath,
      tokens,
      reason,
      timestamp: Date.now(),
    });
  }

  get remainingTokens(): number {
    return Math.max(0, this.totalBudget - this.usedTokens);
  }

  /**
   * Enforces the budget on a tool's text output: records the tokens and, when
   * the output would exceed the remaining budget, truncates it and appends a
   * marker telling the agent to narrow its query. Returns the (possibly
   * truncated) text to send back.
   */
  enforceOutput(text: string, key: string, reason?: string): string {
    const estimatedTokens = Math.ceil(text.length / 4);
    const remaining = this.remainingTokens;

    if (remaining <= 0) {
      this.recordTokens(key, 0, reason);
      return '[context budget exhausted — call get_context_budget_info or narrow your query before reading more code]';
    }

    const allowedChars = remaining * 4;
    if (text.length <= allowedChars) {
      this.recordTokens(key, estimatedTokens, reason);
      return text;
    }

    const kept = text.slice(0, allowedChars);
    const overBy = estimatedTokens - remaining;
    this.recordTokens(key, remaining, reason);
    return `${kept}\n… [truncated: context budget exhausted, ~${overBy} tokens over — narrow your query or read a smaller range]`;
  }

  getBudgetInfo(): BudgetInfo {
    return {
      totalBudget: this.totalBudget,
      usedTokens: this.usedTokens,
      remainingTokens: Math.max(0, this.totalBudget - this.usedTokens),
      overBudget: this.overflowTokens > 0,
      exceededTokens: this.overflowTokens,
      items: [...this.items],
    };
  }

  reset(): void {
    this.usedTokens = 0;
    this.overflowTokens = 0;
    this.items = [];
  }
}

export const globalContextBudget = new ContextBudgetTracker(30000);
