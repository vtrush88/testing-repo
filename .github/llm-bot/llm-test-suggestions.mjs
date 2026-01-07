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

async function chooseModel(client) {
  // Prefer cheaper/faster models for PR comments; fall back safely.
  // NOTE: Availability depends on your account/org.
  const preferred = [
    // If your org has access to newer “gpt-5*” family, keep them first:
    "gpt-5",
    "gpt-5-mini",
    "gpt-5.2",
    "gpt-5.2-mini",

    // Commonly available:
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
  ];

  try {
    const models = await client.models.list(); // GET /v1/models
    const available = new Set((models?.data || []).map((m) => m.id));
    const chosen = preferred.find((m) => available.has(m));
    return chosen || "gpt-4o-mini";
  } catch (err) {
    // If listing models fails (network, auth, etc.), fall back to a sensible default
    console.error("Failed to list models, falling back to default:", err?.message || err);
    return "gpt-4o-mini";
  }
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

// Keep prompt size under control
const MAX_FILES = 30;
const MAX_PATCH_CHARS_PER_FILE = 4000;

const changed = files.slice(0, MAX_FILES).map((f) => ({
  filename: f.filename,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: truncate(toSafePatch(f.patch), MAX_PATCH_CHARS_PER_FILE),
}));

// 3) Build prompt (as requested)
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
${changed
  .map(
    (f, i) => `
${i + 1}. ${f.filename} (${f.status}) +${f.additions}/-${f.deletions}
PATCH:
${f.patch}
`
  )
  .join("\n")}
`.trim();

// 4) Call OpenAI with model auto-selection + graceful fallback
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const chosenModel = await chooseModel(client);

let md;
let modelNote = "";

try {
  const response = await client.responses.create({
    model: chosenModel,
    input: prompt,
  });

  md = (response.output_text || "").trim() || "No output from model.";
  modelNote = `<sub>Model: ${chosenModel}</sub>`;
} catch (err) {
  console.error("LLM error:", err);

  const reason =
    err?.error?.message ||
    err?.message ||
    "Unknown error";

  md = `
⚠️ **LLM test suggestions are temporarily unavailable**

Reason:
- ${reason}

What to do:
- Check OpenAI API billing / quota
- Verify the model is available for this API key
- Re-run the workflow after fixing

This does **not** block the PR.
`.trim();

  modelNote = `<sub>Attempted model: ${chosenModel}</sub>`;
}

// 5) Prepare final comment body
const comment = `
### ✅ QA test suggestions (LLM)

> Generated from PR diff. Please treat as recommendations, not a gate.

${md}

<sub>Files analyzed: ${Math.min(files.length, MAX_FILES)} (of ${files.length})</sub>
${modelNote}
`.trim();

// 6) Output to next step
core.setOutput("body", comment);
