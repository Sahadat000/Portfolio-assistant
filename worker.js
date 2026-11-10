// SahadatLabs assistant backend (Cloudflare Worker)
// Secrets: ASSISTANT_PASSWORD, SESSION_SECRET, GITHUB_WRITE_TOKEN, GEMINI_API_KEY
// Vars: GH_OWNER, SITE_REPO, ALLOWED_ORIGIN, GEMINI_MODEL (optional)

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-3.5-flash";
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
        display_name: { type: "string", description: "Optional. The name to show on the site instead of the repo name (English)." },
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
  {
    name: "search_icons",
    description: "Search the free online Iconify library for icons by English keyword (e.g. robot, rocket, headset). Returns icon ids like mdi:robot-happy. Use before set_icon_from_library.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "English search word" } },
      required: ["query"],
    },
  },
  {
    name: "set_icon_from_library",
    description: "Use an icon from the online Iconify library as the floating assistant button on the dashboard. icon is an id from search_icons, like mdi:robot-happy.",
    input_schema: {
      type: "object",
      properties: { icon: { type: "string", description: "Icon id such as mdi:robot-happy" } },
      required: ["icon"],
    },
  },
  {
    name: "search_icons",
    description: "Search the open Iconify library online for icons by keyword (English). Returns icon ids like lucide:bot. Use it before set_assistant_icon with icon_id.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "English keyword, e.g. robot, rocket, brain" } },
      required: ["query"],
    },
  },
  {
    name: "set_assistant_icon",
    description:
      "Change the floating assistant button on the dashboard. Either icon (built-in: robot, sparkle, chat, rocket, bolt) or icon_id (an id from search_icons, like lucide:bot), and optionally color as a hex code like #e09f3e.",
    input_schema: {
      type: "object",
      properties: {
        icon: { type: "string", description: "robot, sparkle, chat, rocket or bolt" },
        icon_id: { type: "string", description: "Iconify id from search_icons, e.g. lucide:bot" },
        color: { type: "string", description: "Hex color such as #e09f3e" },
      },
    },
  },
  {
    name: "set_display_name",
    description: "Set the name shown on the site for a project, different from the repo name. Pass an empty title to go back to the repo name.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string" }, title: { type: "string", description: "Display name in English, or empty to reset" } },
      required: ["repo", "title"],
    },
  },
  {
    name: "set_featured",
    description: "Mark a repo as featured (shown first on the site, with a star) or remove the featured mark. The repo must also be in the portfolio to appear.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string" }, featured: { type: "boolean", description: "true to feature, false to unfeature" } },
      required: ["repo"],
    },
  },
  {
    name: "site_status",
    description: "Show the latest runs of the site update workflow (status, success or failure, time).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "site_views",
    description: "Show visitor stats for the portfolio site repo for the last 14 days (total views, unique visitors, per day).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_about",
    description: "Read the current About text shown on the site.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_about",
    description:
      "Replace the About text on the site. Text must be in English, first person, clear and concise (under 700 characters). Always show the saved text to the user afterwards.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The new About text in English" } },
      required: ["text"],
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
- After a change, say briefly what changed and whether the site refresh started.
- For About changes: if the user speaks in Bengali, write a polished English first-person text, save it with set_about, then show the saved text.
- The site can show a display name different from the repo name. If the user gives a name for a project, pass it as display_name when adding, or use set_display_name. Display names must be in English; polish them if the user speaks Bengali.
- The floating assistant button on the dashboard can change icon (robot, sparkle, chat, rocket, bolt) and color; use set_assistant_icon. Convert color names to hex codes. For any other icon the user asks for, call search_icons with an English keyword, pick the best match, then set_assistant_icon with icon_id.
- To use an icon found online: call search_icons with an English keyword, pick the best id, then call set_icon_from_library. Tell the user which icon you picked.
- To feature a project (show it first with a star) use set_featured.
- For site status or visitor questions, use site_status and site_views and summarize in a few short lines.`;

function cleanName(s) {
  const n = String(s || "").trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(n)) throw new Error("Invalid repo name");
  return n;
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function readData(env) {
  const f = await gh(env, `/repos/${env.GH_OWNER}/${env.SITE_REPO}/contents/data.json`);
  return { sha: f.sha, data: JSON.parse(b64ToText(f.content)) };
}

async function setAbout(env, text) {
  const clean = String(text || "").trim().slice(0, 1500);
  if (!clean) throw new Error("Empty About text");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, data } = await readData(env);
    data.profile = data.profile || {};
    data.profile.about = clean;
    try {
      await gh(env, `/repos/${env.GH_OWNER}/${env.SITE_REPO}/contents/data.json`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Update About via assistant",
          content: textToB64(JSON.stringify(data, null, 2) + "\n"),
          sha,
        }),
      });
      return clean;
    } catch (e) {
      if (!String(e.message).startsWith("409") || attempt === 2) throw e;
    }
  }
}

async function setDisplayName(env, repo, title) {
  const clean = String(title || "").trim().slice(0, 80);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, data } = await readData(env);
    data.display_names = data.display_names || {};
    if (clean) data.display_names[repo] = clean;
    else delete data.display_names[repo];
    try {
      await gh(env, `/repos/${env.GH_OWNER}/${env.SITE_REPO}/contents/data.json`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Set display name via assistant",
          content: textToB64(JSON.stringify(data, null, 2) + "\n"),
          sha,
        }),
      });
      return clean;
    } catch (e) {
      if (!String(e.message).startsWith("409") || attempt === 2) throw e;
    }
  }
}

function safeSvg(t) {
  return (
    typeof t === "string" &&
    t.startsWith("<svg") &&
    t.length < 12000 &&
    !/<script|<foreignObject|<image|<style|\son[a-z]+\s*=|javascript:|href\s*=|<!ENTITY/i.test(t)
  );
}

async function searchIcons(query) {
  const q = String(query || "").trim().slice(0, 40);
  if (!q) throw new Error("Empty search");
  const r = await fetch(
    "https://api.iconify.design/search?limit=14&prefixes=lucide,tabler,mdi,ph&query=" + encodeURIComponent(q)
  );
  if (!r.ok) throw new Error("Icon search failed (" + r.status + ")");
  const d = await r.json();
  return d.icons || [];
}

async function setAssistantLook(env, icon, color, iconId) {
  const PRESETS = ["robot", "sparkle", "chat", "rocket", "bolt"];
  if (icon && !PRESETS.includes(icon)) throw new Error("Icon must be one of: " + PRESETS.join(", "));
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Color must be a hex code like #e09f3e");
  let svg = null;
  if (iconId) {
    if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(iconId)) throw new Error("Bad icon id");
    const [prefix, nm] = iconId.split(":");
    const r = await fetch(`https://api.iconify.design/${prefix}/${nm}.svg`);
    if (!r.ok) throw new Error("Icon not found: " + iconId);
    svg = (await r.text()).trim();
    if (!safeSvg(svg)) throw new Error("Icon was rejected as unsafe or too large");
  }
  if (!icon && !color && !svg) throw new Error("Give an icon, an icon_id or a color");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, data } = await readData(env);
    data.profile = data.profile || {};
    if (svg) {
      data.profile.assistant_icon = "custom";
      data.profile.assistant_icon_svg = svg;
    } else if (icon) {
      data.profile.assistant_icon = icon;
      delete data.profile.assistant_icon_svg;
    }
    if (color) data.profile.assistant_color = color;
    try {
      await gh(env, `/repos/${env.GH_OWNER}/${env.SITE_REPO}/contents/data.json`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Change assistant button via assistant",
          content: textToB64(JSON.stringify(data, null, 2) + "\n"),
          sha,
        }),
      });
      return {
        icon: iconId || data.profile.assistant_icon || "robot",
        color: data.profile.assistant_color || "default",
      };
    } catch (e) {
      if (!String(e.message).startsWith("409") || attempt === 2) throw e;
    }
  }
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
        featured: (r.topics || []).includes("featured"),
      }));
  }

  if (name === "site_status") {
    const r = await gh(env, `/repos/${owner}/${env.SITE_REPO}/actions/workflows/update.yml/runs?per_page=3`);
    return (r.workflow_runs || []).map((x) => ({
      status: x.status,
      conclusion: x.conclusion,
      trigger: x.event,
      started: x.created_at,
      updated: x.updated_at,
    }));
  }

  if (name === "site_views") {
    const v = await gh(env, `/repos/${owner}/${env.SITE_REPO}/traffic/views`);
    return {
      views_last_14_days: v.count,
      unique_visitors_last_14_days: v.uniques,
      per_day: (v.views || []).map((d) => ({ date: d.timestamp.slice(0, 10), views: d.count, unique: d.uniques })),
    };
  }

  if (name === "search_icons") {
    const q = String(input.query || "").trim().slice(0, 40);
    if (!q) return { error: "Empty search" };
    const r = await fetch(
      `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=12&prefixes=mdi,lucide,tabler,ph,bi`
    );
    if (!r.ok) return { error: "Icon service error " + r.status };
    const j = await r.json();
    return { icons: j.icons || [] };
  }

  if (name === "set_icon_from_library") {
    return { ok: true, icon: await setIconFromLibrary(env, input.icon) };
  }

  if (name === "search_icons") {
    return { icons: await searchIcons(input.query) };
  }

  if (name === "set_assistant_icon") {
    return { ok: true, ...(await setAssistantLook(env, input.icon, input.color, input.icon_id)) };
  }

  if (name === "get_about") {
    const { data } = await readData(env);
    return { about: (data.profile && data.profile.about) || "" };
  }

  if (name === "set_about") {
    return { ok: true, saved_text: await setAbout(env, input.text) };
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
    if (topics.includes("portfolio")) {
      if (input.display_name) {
        const shown = await setDisplayName(env, repoName, input.display_name);
        return { ok: true, note: "Already in portfolio.", display_name: shown };
      }
      return { ok: true, note: "Already in portfolio." };
    }
    await gh(env, `/repos/${owner}/${repoName}/topics`, {
      method: "PUT",
      body: JSON.stringify({ names: [...topics, "portfolio"] }),
    });
    state.changed = true;
    let shownName = "";
    if (input.display_name) shownName = await setDisplayName(env, repoName, input.display_name);
    return { ok: true, added: repoName, display_name: shownName };
  }

  if (name === "set_display_name") {
    const shown = await setDisplayName(env, repoName, input.title);
    state.changed = true;
    return { ok: true, repo: repoName, display_name: shown || "(reset to repo name)" };
  }

  if (name === "set_featured") {
    const want = input.featured !== false;
    const has = topics.includes("featured");
    if (want === has) return { ok: true, note: "No change needed." };
    const names = want ? [...topics, "featured"] : topics.filter((t) => t !== "featured");
    await gh(env, `/repos/${owner}/${repoName}/topics`, { method: "PUT", body: JSON.stringify({ names }) });
    state.changed = true;
    return {
      ok: true,
      repo: repoName,
      featured: want,
      note: topics.includes("portfolio") ? "" : "This repo is not in the portfolio yet, so it will not show on the site.",
    };
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

async function callGemini(env, payload) {
  const models = [env.GEMINI_MODEL || DEFAULT_MODEL, env.GEMINI_FALLBACK_MODEL || FALLBACK_MODEL];
  let lastErr = "Gemini API error";
  for (const model of models) {
    let withThinking = true; // ask for fast, low-effort thinking; drop it if the model rejects it
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = withThinking
        ? { ...payload, generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }
        : payload;
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      let data = {};
      try {
        data = await r.json();
      } catch {}
      if (r.ok) return data;
      lastErr = (data.error && data.error.message) || "Gemini API error (" + r.status + ")";
      if (r.status === 400 && withThinking) {
        withThinking = false;
        attempt--;
        continue;
      }
      if (r.status === 404 || r.status === 400) break;
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr);
}

async function chat(env, messages) {
  const state = { changed: false, dispatched: false };
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  for (let step = 0; step < 6; step++) {
    const data = await callGemini(env, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: GEMINI_TOOLS,
    });

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
      if (env.LOGIN_LIMITER) {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
        if (!success) return json(env, { error: "Too many attempts. Wait a minute." }, 429);
      }
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

    if (url.pathname === "/quick") {
      if (!(await checkToken(env, req))) return json(env, { error: "Session expired" }, 401);
      let body = {};
      try {
        body = await req.json();
      } catch {}
      try {
        const state = {};
        if (body.cmd === "repos") {
          const list = await runTool(env, "list_repos", {}, state);
          const lines = list.map(
            (r) =>
              `${r.in_portfolio ? "\u2705" : "\u2b1c"}${r.featured ? "\u2b50" : ""} ${r.name} (${r.private ? "private" : "public"})`
          );
          return json(env, { reply: "On site = \u2705, not on site = \u2b1c, featured = \u2b50\n\n" + lines.join("\n") });
        }
        if (body.cmd === "status") {
          const runs = await runTool(env, "site_status", {}, state);
          const lines = runs.map(
            (x) =>
              `${x.status === "completed" ? x.conclusion : x.status} - ${x.trigger} - ${String(x.updated).replace("T", " ").slice(0, 16)} UTC`
          );
          return json(env, { reply: "Latest site updates:\n" + (lines.join("\n") || "No runs yet.") });
        }
        if (body.cmd === "views") {
          const v = await runTool(env, "site_views", {}, state);
          return json(env, {
            reply: `Last 14 days:\nViews: ${v.views_last_14_days}\nUnique visitors: ${v.unique_visitors_last_14_days}`,
          });
        }
        return json(env, { error: "Unknown command" }, 400);
      } catch (e) {
        return json(env, { error: e.message }, 500);
      }
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
