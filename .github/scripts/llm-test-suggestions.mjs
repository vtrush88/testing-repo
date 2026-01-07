import OpenAI from "openai";
import core from "@actions/core";
import github from "@actions/github";

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max) + "\n…(truncated)";
}

function toSafePatch(patch) {
  // GitHub sometimes omits patches for big diffs; handle gracefully
  return patch || "(no patch provided by GitHub for this file)";
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = Number(process.env.PR_NUMBER);
const REPO = process.env.REPO;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret");
if (!GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");
if (!PR_NUMBER) throw new Error("Missing PR_NUMBER");
if (!REPO) throw new Error("Missing REPO");

const [owner, repo] = REPO.split("/");
const octokit = github.getOctokit(GITHUB_TOKEN);

// 1) Fetch PR metadata
const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: PR_NUMBER });

// 2) Fetch changed files (includes 'patch' for each file when available)
const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
  owner,
  repo,
  pull_number: PR_NUMBER,
  per_page: 100,
});

// Keep prompt size under control: include top N files, truncate patches
const MAX_FILES = 30;
const MAX_PATCH_CHARS_PER_FILE = 4000;

const changed = files.slice(0, MAX_FILES).map(f => ({
  filename: f.filename,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: truncate(toSafePatch(f.patch), MAX_PATCH_CHARS_PER_FILE),
}));

// 3) Build a strong prompt (structured output)
const prompt = `
You are a senior QA engineer. Based on a GitHub Pull Request diff, propose what should be tested.

Return ONLY GitHub-flavored Markdown. No JSON. No code blocks unless you include example test names.
Constraints:
- Focus on "what to test" and risk areas, not implementation details.
- Include: (1) High-risk areas, (2) Suggested test checklist, (3) Regression areas, (4) Test data/environment notes, (5) Questions/assumptions.
- Be explicit about edge cases and negative cases.
- If the diff is insufficient, state what info is missing.

PR title: ${pr.data.title}
PR author: ${pr.data.user?.login}
Base: ${pr.data.base?.ref}  Head: ${pr.data.head?.ref}
PR url: ${pr.data.html_url}

Changed files (with patches, may be truncated):
${changed.map((f, i) => `
${i + 1}. ${f.filename} (${f.status}) +${f.additions}/-${f.deletions}
PATCH:
${f.patch}
`).join("\n")}
`.trim();

// 4) Call OpenAI Responses API (official SDK)
// Docs show responses.create() with Bearer key auth in env. :contentReference[oaicite:3]{index=3}
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const response = await client.responses.create({
  model: "gpt-5.2", // you can swap to gpt-5.2-mini for cost
  input: prompt,
});

const md = response.output_text?.trim() || "No output from model.";

// 5) Prepare final comment body
const comment = `
### ✅ QA test suggestions (LLM)

> Generated from PR diff. Please treat as recommendations, not a gate.

${md}

<sub>Files analyzed: ${Math.min(files.length, MAX_FILES)} (of ${files.length})</sub>
`.trim();

// 6) Output to next step (GitHub Actions output)
core.setOutput("body", comment);
