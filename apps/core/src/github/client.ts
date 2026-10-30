import { Octokit } from "@octokit/rest";
import { env } from "../env.js";

export const gh = new Octokit({ auth: env.githubToken, userAgent: "case-ai" });
