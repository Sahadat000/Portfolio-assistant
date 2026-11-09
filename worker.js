// SahadatLabs assistant backend (Cloudflare Worker)
// Secrets: ASSISTANT_PASSWORD, SESSION_SECRET, GITHUB_WRITE_TOKEN, GEMINI_API_KEY
// Vars: GH_OWNER, SITE_REPO, ALLOWED_ORIGIN, GEMINI_MODEL (optional)

const DEFAULT_MODEL = "gemini-3.5-flash";
const SESSION_MS = 4 * 60 * 60 * 1000;
const enc = new TextEncoder();

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeToken(env) {
  const exp = String(Date.now() + SESSION_MS);
  return exp + "." + (await hmac(env.SESSION_SECRET, exp));
}

async function checkToken(env, req) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!safeEq(sig, await hmac(env.SESSION_SECRET, exp))) return false;
  return Number(exp) > Date.now();
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

async function gh(env, path, opts = {}) {
  const r = await fetch("https://api.github.com" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + env.GITHUB_WRITE_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "sahadatlabs-assistant",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(r.status + " " + ((body && body.message) || text));
  return body;
}

async function triggerSiteUpdate(env) {
  try {
    await gh(
      env,
      `/repos/${env.GH_OWNER}/${env.SITE_REPO}/actions/workflows/update.yml/dispatches`,
      { method: "POST", body: JSON.stringify({ ref: "main" }) }
    );
    return "Site refresh started.";
  } catch (e) {
    return "Could not start site refresh (" + e.message + "). It will update on the next hourly run.";
  }
}

const TOOLS = [
  {
    name: "list_repos",
    description:
      "List the owner's GitHub repos with name, private flag, description, topics, fork/archived flags and whether each is currently in the portfolio (topic 'portfolio').",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_to_portfolio",
    description:
      "Add the topic 'portfolio' to a repo so it shows on the site. For private repos, first ask the user to confirm, then call again with confirm_private=true.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name only, e.g. my-bot" },
        confirm_private: { type: "boolean" },
      },
      required: ["repo"],
    },
  },
  {
    name: "remove_from_portfolio",
    description: "Remove the topic 'portfolio' from a repo so it no longer shows on the site.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
  },
  {
    name: "set_description",
    description: "Set the GitHub description of a repo (shown on the site). Write it in English.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string" }, description: { type: "string" } },
      required: ["repo", "description"],
    },
  },
];

const SYSTEM = `You are the dashboard assistant for Sahadat's portfolio site "SahadatLabs".
You manage which GitHub repos appear on the site, using tools.
- A repo is on the site when it has the GitHub topic "portfolio".
- Before adding a PRIVATE repo, tell the user it will show its name and description publicly and ask for confirmation. Only then call add_to_portfolio with confirm_private=true.
- Repo names and descriptions on the site must be in English.
- Reply in the same language the user writes in (usually Bengali). Keep replies short, plain text, no markdown tables.
- Never guess repo names: call list_repos if unsure.
- After a change, say briefly what changed and whether the site refresh started.`;

function cleanName(s) {
  const n = String(s || "").trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(n)) throw new Error("Invalid repo name");
  return n;
}

async function runTool(env, name, input, state) {
  const owner = env.GH_OWNER;
  if (name === "list_repos") {
    const repos = await gh(env, `/user/repos?per_page=100&affiliation=owner&sort=updated`);
    return repos
      .filter((r) => r.owner.login === owner)
      .map((r) => ({
        name: r.name,
        private: r.private,
        description: r.description,
        fork: r.fork,
        archived: r.archived,
        in_portfolio: (r.topics || []).includes("portfolio"),
      }));
  }

  const repoName = cleanName(input.repo);
  const repo = await gh(env, `/repos/${owner}/${repoName}`);
  const topics = repo.topics || [];

  if (name === "add_to_portfolio") {
    if (repo.fork || repo.archived) {
      return { error: "Forks and archived repos are not shown on the site." };
    }
    if (repo.private && !input.confirm_private) {
      return { needs_confirmation: true, message: "This repo is private. Ask the user to confirm." };
    }
    if (topics.includes("portfolio")) return { ok: true, note: "Already in portfolio." };
    await gh(env, `/repos/${owner}/${repoName}/topics`, {
      method: "PUT",
      body: JSON.stringify({ names: [...topics, "portfolio"] }),
    });
    state.changed = true;
    return { ok: true, added: repoName };
  }

  if (name === "remove_from_portfolio") {
    if (!topics.includes("portfolio")) return { ok: true, note: "Was not in portfolio." };
    await gh(env, `/repos/${owner}/${repoName}/topics`, {
      method: "PUT",
      body: JSON.stringify({ names: topics.filter((t) => t !== "portfolio") }),
    });
    state.changed = true;
    return { ok: true, removed: repoName };
  }

  if (name === "set_description") {
    const description = String(input.description || "").slice(0, 300);
    await gh(env, `/repos/${owner}/${repoName}`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
    state.changed = true;
    return { ok: true, repo: repoName, description };
  }

  return { error: "Unknown tool" };
}

function toGemini(schema) {
  const out = { type: String(schema.type).toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toGemini(v);
  }
  if (schema.required) out.required = schema.required;
  return out;
}

const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOLS.map((t) => {
      const d = { name: t.name, description: t.description };
      const props = t.input_schema.properties;
      if (props && Object.keys(props).length) d.parameters = toGemini(t.input_schema);
      return d;
    }),
  },
];

async function chat(env, messages) {
  const state = { changed: false, dispatched: false };
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  for (let step = 0; step < 6; step++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools: GEMINI_TOOLS,
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error((data.error && data.error.message) || "Gemini API error");

    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("\n")
        .trim();
      return text || "No reply. Please try again.";
    }

    // Keep the model turn exactly as returned (it may carry thought signatures)
    contents.push(cand.content);
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      let out;
      try {
        out = await runTool(env, name, args || {}, state);
        if (state.changed && !state.dispatched && name !== "list_repos") {
          state.dispatched = true;
          out = { ...out, site: await triggerSiteUpdate(env) };
        }
      } catch (e) {
        out = { error: e.message };
      }
      responses.push({ functionResponse: { name, response: { result: out } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return "Too many steps. Please try a simpler command.";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (req.method !== "POST") return json(env, { error: "Not found" }, 404);

    const origin = req.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return json(env, { error: "Forbidden" }, 403);
    }

    if (url.pathname === "/login") {
      let body = {};
      try {
        body = await req.json();
      } catch {}
      const a = await hmac(env.SESSION_SECRET, String(body.password || ""));
      const b = await hmac(env.SESSION_SECRET, env.ASSISTANT_PASSWORD);
      if (!safeEq(a, b)) {
        await new Promise((r) => setTimeout(r, 600));
        return json(env, { error: "Wrong password" }, 401);
      }
      return json(env, { token: await makeToken(env) });
    }

    if (url.pathname === "/chat") {
      if (!(await checkToken(env, req))) return json(env, { error: "Session expired" }, 401);
      let body = {};
      try {
        body = await req.json();
      } catch {}
      const messages = (Array.isArray(body.messages) ? body.messages : [])
        .slice(-20)
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!messages.length || messages[0].role !== "user") {
        return json(env, { error: "Bad request" }, 400);
      }
      try {
        return json(env, { reply: await chat(env, messages) });
      } catch (e) {
        return json(env, { error: e.message }, 500);
      }
    }

    return json(env, { error: "Not found" }, 404);
  },
};
