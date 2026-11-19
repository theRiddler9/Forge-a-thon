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
  items: BudgetItem[];
}

export class ContextBudgetTracker {
  private totalBudget: number;
  private usedTokens: number = 0;
  private items: BudgetItem[] = [];

  constructor(totalBudget: number = 30000) {
    this.totalBudget = totalBudget;
  }

  setBudget(totalBudget: number): void {
    this.totalBudget = totalBudget;
  }

  recordTokens(filePath: string, tokens: number, reason?: string): void {
    this.usedTokens += tokens;
    this.items.push({
      path: filePath,
      tokens,
      reason,
      timestamp: Date.now(),
    });
  }

  getBudgetInfo(): BudgetInfo {
    return {
      totalBudget: this.totalBudget,
      usedTokens: this.usedTokens,
      remainingTokens: Math.max(0, this.totalBudget - this.usedTokens),
      items: [...this.items],
    };
  }

  reset(): void {
    this.usedTokens = 0;
    this.items = [];
  }
}

export const globalContextBudget = new ContextBudgetTracker(30000);
