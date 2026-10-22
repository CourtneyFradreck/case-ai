export type Severity = "high" | "medium" | "low" | "info";

export interface Source { label: string; url: string }

export type Activity =
  | { kind: "commits"; count: number; branch: string; messages: string[] }
  | { kind: "pr" | "issue"; action: "Opened" | "Merged" | "Closed"; number: number; title: string };

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  repo: string;
  summary: string;        // plain text; render.ts escapes it
  details?: string[];     // optional sub-lines (e.g. commit messages)
  sources: Source[];
  ageDays?: number;       // for sorting within a severity
  activity?: Activity;   // structured recap facts, independent of model wording
  intent?: { itemId: string; section: string | null; state: "open" | "done" };
}

export interface Commit { sha: string; message: string; url: string; author: string; date: string; branch: string; parentSha?: string }
export interface Pr { number: number; title: string; url: string; draft: boolean; headRef: string; updatedAt: string; createdAt?: string; mergedAt?: string | null }
export interface Issue { number: number; title: string; url: string; createdAt: string; state?: string }
export interface ClosedIssue { number: number; title: string; url: string; closedAt: string }
export interface IssueComment {
  id: number; issueNumber: number; issueTitle: string; isPr: boolean;
  author: string; url: string; createdAt: string; mine: boolean;
}
export interface Branch { name: string; sha: string; lastCommitAt: string; aheadBy: number; url: string }
export interface CiRun { workflowId: number; workflowName: string; conclusion: string | null; url: string; finishedAt: string }

export interface NextItem {
  id: string; text: string; section: string | null;
  state: "open" | "done"; line: number;   // 1-based line number in NEXT.md
}
export type NextFile =
  | { status: "ok"; sha: string; url: string; lastChangedAt: string | null; items: NextItem[] }
  | { status: "missing" }
  | { status: "error"; error: string };

export interface RepoSnapshot {
  repo: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  commits: Commit[];
  openPrs: Pr[];
  openedPrs: Pr[];
  mergedPrs: Pr[];
  recentlyMerged?: Pr[];  // merged PRs among the 50 most recently updated closed ones, any date
  newIssues: Issue[];
  closedIssues: ClosedIssue[];
  comments: IssueComment[];
  openIssueCount: number;
  branches: Branch[];
  ciRuns: CiRun[];        // latest completed run per workflow on default branch
  next: NextFile;         // NEXT.md on the default branch
  error?: string;         // set if this repo couldn't be read
}
