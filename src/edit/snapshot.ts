export interface FileSnapshot {
  id: string;
  filePath: string;
  restoredContent: string;
  timestamp: number;
}

export class SnapshotManager {
  private history: FileSnapshot[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 50) {
    this.maxHistory = maxHistory;
  }

  createSnapshot(filePath: string, contentBefore: string): string {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.history.push({
      id,
      filePath,
      restoredContent: contentBefore,
      timestamp: Date.now(),
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    return id;
  }

  historySize(): number {
    return this.history.length;
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  undoLastChange(): FileSnapshot | null {
    if (this.history.length === 0) {
      return null;
    }
    return this.history.pop() ?? null;
  }

  peekLastChange(): FileSnapshot | null {
    if (this.history.length === 0) {
      return null;
    }
    return this.history[this.history.length - 1];
  }

  clear(): void {
    this.history = [];
  }
}

export const globalSnapshotManager = new SnapshotManager();
