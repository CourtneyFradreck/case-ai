export type Severity = "high" | "medium" | "low" | "info";

export interface Source { label: string; url: string }

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  repo: string;
  summary: string;        // plain text; render.ts escapes it
  details?: string[];     // optional sub-lines (e.g. commit messages)
  sources: Source[];
  ageDays?: number;       // for sorting within a severity
}

export interface Commit { sha: string; message: string; url: string; author: string; date: string; branch: string; parentSha?: string }
export interface Pr { number: number; title: string; url: string; draft: boolean; headRef: string; updatedAt: string; mergedAt?: string | null }
export interface Issue { number: number; title: string; url: string; createdAt: string }
export interface ClosedIssue { number: number; title: string; url: string; closedAt: string }
export interface IssueComment {
  id: number; issueNumber: number; issueTitle: string; isPr: boolean;
  author: string; url: string; createdAt: string; mine: boolean;
}
export interface Branch { name: string; sha: string; lastCommitAt: string; aheadBy: number; url: string }
export interface CiRun { workflowId: number; workflowName: string; conclusion: string | null; url: string; finishedAt: string }

export interface RepoSnapshot {
  repo: string;
  private: boolean;
  defaultBranch: string;
  commits: Commit[];
  openPrs: Pr[];
  mergedPrs: Pr[];
  newIssues: Issue[];
  closedIssues: ClosedIssue[];
  comments: IssueComment[];
  openIssueCount: number;
  lastCommitAt: string | null;
  branches: Branch[];
  ciRuns: CiRun[];        // latest completed run per workflow on default branch
  error?: string;         // set if this repo couldn't be read
}
