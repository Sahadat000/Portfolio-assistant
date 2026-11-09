// Cloudflare Worker: SahadatLabs assistant backend
// Secrets (set in Cloudflare, NEVER in code):
//   ASSISTANT_PASSWORD, SESSION_SECRET, GITHUB_WRITE_TOKEN, ANTHROPIC_API_KEY
// Variables (plain): GH_OWNER=Sahadat000, SITE_REPO=My-portfolio,
//   ALLOWED_ORIGIN=https://sahadat000.github.io

const TOPIC = "portfolio";
const SESSION_HOURS = 4;
const enc = new TextEncoder();

const cors = (env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});
const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });

// ---------- session tokens (HMAC signed) ----------
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function makeToken(env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return exp + "." + (await hmac(env.SESSION_SECRET, String(exp)));
}
async function validToken(env, token) {
  const [exp, sig] = (token || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- GitHub helpers ----------
async function gh(env, path, method = "GET", body) {
  const res = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.GITHUB_WRITE_TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sahadatlabs-assistant",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("GitHub " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.status === 204 ? {} : res.json();
}
// Re-run the site's workflow so changes appear right away (best effort)
async function refreshSite(env) {
  try {
    await gh(env, `/repos/${env.GH_OWNER}/${env.SITE_REPO}/actions/workflows/update.yml/dispatches`,
      "POST", { ref: "main" });
  } catch (e) { /* ignore: hourly run will pick it up */ }
}

const tools = {
  async list_repos(env) {
    const repos = await gh(env, "/user/repos?per_page=100&affiliation=owner&sort=pushed");
    return repos.filter((r) => !r.fork && !r.archived).map((r) => ({
      name: r.name, private: r.private, description: r.description || "",
      on_portfolio: (r.topics || []).includes(TOPIC),
    }));
  },
  async add_to_portfolio(env, { repo }) {
    const cur = await gh(env, `/repos/${env.GH_OWNER}/${repo}/topics`);
    const names = [...new Set([...(cur.names || []), TOPIC])];
    await gh(env, `/repos/${env.GH_OWNER}/${repo}/topics`, "PUT", { names });
    await refreshSite(env);
    return { ok: true, repo, topics: names };
  },
  async remove_from_portfolio(env, { repo }) {
    const cur = await gh(env, `/repos/${env.GH_OWNER}/${repo}/topics`);
    const names = (cur.names || []).filter((t) => t !== TOPIC);
    await gh(env, `/repos/${env.GH_OWNER}/${repo}/topics`, "PUT", { names });
    await refreshSite(env);
    return { ok: true, repo, topics: names };
  },
  async set_description(env, { repo, text }) {
    await gh(env, `/repos/${env.GH_OWNER}/${repo}`, "PATCH", { description: text });
    await refreshSite(env);
    return { ok: true, repo, description: text };
  },
};

const toolDefs = [
  { name: "list_repos", description: "List the owner's repos with private flag, description and whether each is on the portfolio.",
    input_schema: { type: "object", properties: {} } },
  { name: "add_to_portfolio", description: "Show a repo on the portfolio site (adds the 'portfolio' topic).",
    input_schema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "remove_from_portfolio", description: "Hide a repo from the portfolio site.",
    input_schema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "set_description", description: "Set a repo's short English description (what it is used for).",
    input_schema: { type: "object", properties: { repo: { type: "string" }, text: { type: "string" } }, required: ["repo", "text"] } },
];

const SYSTEM = `You are the SahadatLabs portfolio assistant. You manage which GitHub repos appear on the owner's public portfolio site.
Rules:
- Use list_repos first if you are unsure of an exact repo name.
- Before adding a PRIVATE repo, warn that its name and description become public and ask for confirmation. Only add it after the user says yes.
- Write descriptions in clear, short English.
- Never reveal tokens or secrets. Reply briefly. The user may write in Bengali; reply in the user's language.`;

// ---------- chat loop ----------
async function chat(env, messages) {
  for (let round = 0; round < 6; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1000,
        system: SYSTEM, tools: toolDefs, messages,
      }),
    });
    if (!res.ok) throw new Error("Anthropic " + res.status);
    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });
    const calls = data.content.filter((b) => b.type === "tool_use");
    if (!calls.length) {
      return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const results = [];
    for (const c of calls) {
      let out, isErr = false;
      try { out = await tools[c.name](env, c.input || {}); }
      catch (e) { out = String(e.message || e); isErr = true; }
      results.push({ type: "tool_result", tool_use_id: c.id, is_error: isErr, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return "Too many steps. Please try a simpler request.";
}

// ---------- routes ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method !== "POST") return json(env, { error: "Not found" }, 404);
    const path = new URL(request.url).pathname;
    let body;
    try { body = await request.json(); } catch { return json(env, { error: "Bad request" }, 400); }

    if (path === "/login") {
      const ok = typeof body.password === "string" &&
        safeEqual(await hmac("pw", body.password), await hmac("pw", env.ASSISTANT_PASSWORD));
      if (!ok) { await new Promise((r) => setTimeout(r, 1500)); return json(env, { error: "Wrong password" }, 401); }
      return json(env, { token: await makeToken(env) });
    }

    if (path === "/chat") {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      if (!(await validToken(env, token))) return json(env, { error: "Locked" }, 401);
      if (!Array.isArray(body.messages)) return json(env, { error: "Bad request" }, 400);
      // keep only plain text turns from the browser; tool calls stay server-side
      const messages = body.messages.slice(-20).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000),
      }));
      try { return json(env, { reply: await chat(env, messages) }); }
      catch (e) { return json(env, { error: "Assistant error" }, 500); }
    }
    return json(env, { error: "Not found" }, 404);
  },
};
