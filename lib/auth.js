"use strict";

/* ============================================================================
 * AUTENTICACAO (Supabase Auth, e-mail + senha)
 *
 * - Login valida as credenciais direto no Supabase (grant_type=password).
 * - Os tokens ficam em cookies httpOnly (nao acessiveis por JavaScript).
 * - Todas as rotas (paginas, estaticos e /api) exigem sessao valida, exceto a
 *   tela de login e seus assets.
 * - Sem dependencias extras: usa apenas fetch nativo (Node 18+).
 * - Usuarios sao criados manualmente no painel do Supabase (Authentication >
 *   Users); nao ha cadastro nem recuperacao de senha.
 * ==========================================================================*/

const path = require("path");
const express = require("express");

const AT_COOKIE = "pcx_at";
const RT_COOKIE = "pcx_rt";
const RT_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

const PUBLIC_PATHS = new Set([
  "/login",
  "/auth/login",
  "/auth/logout",
  "/healthz",
  "/css/styles.css",
  "/css/login.css",
  "/js/login.js",
]);

function cfg() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_ANON_KEY || "").trim();
  /* SUPABASE_URL precisa ser a "Project URL" (https://<ref>.supabase.co) e
   * NAO a string de conexao do Postgres (essa e a DATABASE_URL). */
  const validUrl = /^https?:\/\/[^\s@]+$/i.test(url);
  return { url, key, validUrl, ok: Boolean(validUrl && key) };
}

function supabase(pathname, opts) {
  const { url, key } = cfg();
  return fetch(url + pathname, {
    method: (opts && opts.method) || "GET",
    headers: Object.assign(
      { apikey: key, "Content-Type": "application/json" },
      (opts && opts.headers) || {},
    ),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
}

/* ---- cookies ---- */
function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        /* cookie malformado: ignora */
      }
    });
  return out;
}

function isSecure(req) {
  return (
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").split(",")[0] === "https"
  );
}

function cookieStr(name, value, maxAge, req) {
  return (
    name +
    "=" +
    encodeURIComponent(value) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAge +
    (isSecure(req) ? "; Secure" : "")
  );
}

function setSession(req, res, session) {
  const at = Math.max(60, parseInt(session.expires_in, 10) || 3600);
  res.setHeader("Set-Cookie", [
    cookieStr(AT_COOKIE, session.access_token, at, req),
    cookieStr(RT_COOKIE, session.refresh_token, RT_MAX_AGE, req),
  ]);
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", [
    cookieStr(AT_COOKIE, "", 0, req),
    cookieStr(RT_COOKIE, "", 0, req),
  ]);
}

/* ---- verificacao de sessao ---- */
const userCache = new Map(); // access_token -> { user, exp }
const refreshing = new Map(); // refresh_token -> Promise
const CACHE_MS = 30 * 1000;

async function getUser(accessToken) {
  const hit = userCache.get(accessToken);
  if (hit && hit.exp > Date.now()) return hit.user;
  const r = await supabase("/auth/v1/user", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) {
    userCache.delete(accessToken);
    return null;
  }
  const user = await r.json();
  if (userCache.size > 500) userCache.clear();
  userCache.set(accessToken, { user, exp: Date.now() + CACHE_MS });
  return user;
}

function refresh(refreshToken) {
  if (!refreshing.has(refreshToken)) {
    const p = supabase("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: refreshToken },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => setTimeout(() => refreshing.delete(refreshToken), 5000));
    refreshing.set(refreshToken, p);
  }
  return refreshing.get(refreshToken);
}

/* Retorna { user, session? } ou null. "session" vem preenchido quando o token
 * foi renovado e os cookies precisam ser reemitidos. */
async function authenticate(req) {
  if (!cfg().ok) return null;
  const c = parseCookies(req.headers.cookie);
  try {
    if (c[AT_COOKIE]) {
      const user = await getUser(c[AT_COOKIE]);
      if (user) return { user };
    }
    if (c[RT_COOKIE]) {
      const session = await refresh(c[RT_COOKIE]);
      if (session && session.access_token) {
        return { user: session.user, session };
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

/* ---- limitador simples de tentativas de login (por IP) ---- */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, a);
  if (attempts.size > 2000) attempts.clear();
  return a.length >= MAX_ATTEMPTS;
}
function registerFail(ip) {
  const a = attempts.get(ip) || [];
  a.push(Date.now());
  attempts.set(ip, a);
}

/* ---- instalacao no app Express (chamar ANTES de qualquer outra rota) ---- */
function install(app) {
  const c = cfg();
  if (!c.key || !c.url) {
    console.error(
      "[AUTH] SUPABASE_URL e/ou SUPABASE_ANON_KEY ausentes: o login nao vai funcionar. Consulte .env.example.",
    );
  } else if (!c.validUrl) {
    console.error(
      "[AUTH] SUPABASE_URL invalida: deve ser a Project URL (https://<ref>.supabase.co), nao a string de conexao do Postgres.",
    );
  }

  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/login", async (req, res) => {
    const auth = await authenticate(req);
    if (auth) {
      if (auth.session) setSession(req, res, auth.session);
      return res.redirect("/");
    }
    res.sendFile(path.join(__dirname, "..", "login.html"));
  });

  app.post("/auth/login", express.json({ limit: "10kb" }), async (req, res) => {
    if (!cfg().ok)
      return res
        .status(500)
        .json({
          error:
            "Autenticação mal configurada no servidor (SUPABASE_URL/SUPABASE_ANON_KEY).",
        });

    const ip = String(
      (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0],
    ).trim();
    if (tooMany(ip))
      return res.status(429).json({
        error: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      });

    const email = String((req.body && req.body.email) || "")
      .trim()
      .toLowerCase();
    const password = String((req.body && req.body.password) || "");
    if (!email || !password || email.length > 254 || password.length > 256)
      return res.status(400).json({ error: "Informe e-mail e senha." });

    try {
      const r = await supabase("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email, password },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        if (r.status >= 500)
          return res.status(502).json({
            error: "Serviço de autenticação indisponível. Tente novamente.",
          });
        registerFail(ip);
        return res
          .status(401)
          .json({ error: "E-mail ou senha incorretos." });
      }
      setSession(req, res, data);
      res.json({ ok: true, redirect: "/" });
    } catch (e) {
      console.error("[AUTH] Falha ao contatar o Supabase:", e && e.message);
      res.status(502).json({
        error: "Não foi possível contatar o serviço de autenticação.",
      });
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const c = parseCookies(req.headers.cookie);
    if (c[AT_COOKIE]) {
      userCache.delete(c[AT_COOKIE]);
      try {
        await supabase("/auth/v1/logout?scope=local", {
          method: "POST",
          headers: { Authorization: "Bearer " + c[AT_COOKIE] },
        });
      } catch (e) {
        /* encerra a sessao local mesmo se o Supabase estiver fora */
      }
    }
    clearSession(req, res);
    res.json({ ok: true, redirect: "/login" });
  });

  /* Portao: tudo que nao for publico exige sessao valida. */
  app.use(async (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const auth = await authenticate(req);
    if (auth) {
      if (auth.session) setSession(req, res, auth.session);
      req.user = auth.user;
      return next();
    }
    clearSession(req, res);
    const wantsPage =
      req.method === "GET" &&
      !req.path.startsWith("/api/") &&
      String(req.headers.accept || "").includes("text/html");
    if (wantsPage) return res.redirect("/login");
    res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  });
}

module.exports = { install };
