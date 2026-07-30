#!/usr/bin/env node
"use strict";

/* ============================================================================
 * MAPA DE EMPREENDIMENTOS -- SDUH/PE
 * Arquivo unico de codigo-fonte (server.js).
 *
 * Este projeto contem APENAS a funcionalidade de mapa. Toda a integracao
 * com o PostgreSQL/PostGIS utilizada pelo mapa foi preservada sem alteracoes
 * de comportamento (mesmas consultas SQL, mesmos endpoints, mesma logica de
 * resolucao de colunas e conversao de geometria).
 * ==========================================================================*/

/* ### REGIAO: IMPORTS ### */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const { Pool } = require("pg");
const format = require("pg-format");

/* ### REGIAO: CONFIGURACAO / VARIAVEIS DE AMBIENTE ### */
const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_URL: process.env.DATABASE_URL || "",
  NODE_ENV: process.env.NODE_ENV || "production",
  TRUST_PROXY:
    process.env.TRUST_PROXY !== undefined
      ? process.env.TRUST_PROXY === "1"
      : (process.env.NODE_ENV || "production") === "production",
};

const REQUIRED_ENV = ["DATABASE_URL"];
const missingEnv = REQUIRED_ENV.filter((k) => !CONFIG[k]);
if (missingEnv.length) {
  console.error(
    "[BOOT] Variaveis de ambiente obrigatorias ausentes: " +
      missingEnv.join(", "),
  );
  console.error(
    "[BOOT] Consulte README.md / .env.example. A aplicacao nao sera iniciada.",
  );
  process.exit(1);
}

/* ### REGIAO: LOGGER SIMPLES ### */
const LOG_RING = [];
const LOG_RING_MAX = 2000;
function logEvent(level, category, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    meta: meta || null,
  };
  LOG_RING.push(entry);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
  const line =
    "[" +
    entry.ts +
    "] [" +
    level.toUpperCase() +
    "] [" +
    category +
    "] " +
    message;
  if (level === "error") console.error(line, meta || "");
  else console.log(line);
}

/* ### REGIAO: UTILITARIOS DE VALIDACAO ### */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
function isValidIdentifier(name) {
  return typeof name === "string" && IDENTIFIER_RE.test(name);
}
function sanitizeIdentifierOrThrow(name, kind) {
  if (!isValidIdentifier(name)) {
    const err = new Error(
      "Nome de " +
        (kind || "identificador") +
        ' invalido: "' +
        name +
        '". Use apenas letras, numeros e underscore, comecando com letra ou underscore (max 63 caracteres).',
    );
    err.code = "INVALID_IDENTIFIER";
    err.httpStatus = 400;
    throw err;
  }
  return name;
}

/* ### REGIAO: BANCO DE DADOS (POSTGRESQL) ### */
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl:
    /sslmode=require/.test(CONFIG.DATABASE_URL) ||
    /supabase\.co/.test(CONFIG.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on("error", (err) => {
  logEvent("error", "db", "Erro no pool PostgreSQL", { error: err.message });
});

/* app_settings e a unica tabela de sistema que o mapa precisa: guarda a
 * escolha de schema/tabela/coluna espacial feita pelo usuario na tela de
 * configuracao do mapa. */
async function ensureSystemTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
  logEvent("info", "db", "Tabela app_settings verificada/criada.");
}

async function getAppSetting(key) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1;`,
    [key],
  );
  return rows.length ? rows[0].value : null;
}
async function setAppSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now();`,
    [key, JSON.stringify(value)],
  );
}

async function listUserTables() {
  const { rows } = await pool.query(`SELECT table_name,
    (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS column_count
    FROM information_schema.tables t WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;`);
  return rows;
}

async function getTableColumns(tableName) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position;`,
    [tableName],
  );
  return rows;
}

/* Versao generica de getTableColumns que aceita qualquer schema (nao so
 * "public") e enxerga tabelas, views e materialized views igualmente --
 * usada pela funcionalidade de Mapa. */
async function getSchemaTableColumns(schema, tableName) {
  sanitizeIdentifierOrThrow(schema, "schema");
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum;`,
    [schema, tableName],
  );
  return rows.map((r) => r.column_name);
}

async function getTableRowCount(tableName) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const { rows } = await pool.query(
    format("SELECT count(*)::int AS count FROM %I;", tableName),
  );
  return rows[0].count;
}

async function previewTable(tableName, limit) {
  sanitizeIdentifierOrThrow(tableName, "tabela");
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const { rows } = await pool.query(
    format("SELECT * FROM %I LIMIT %L;", tableName, safeLimit),
  );
  return rows;
}

/* ### REGIAO: EXPRESS APP ### */
const app = express();
if (CONFIG.TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

/* ### REGIAO: ASSETS ESTATICOS DO MAPA (LEAFLET, 100% LOCAL) ###
 * O mapa usa Leaflet + Leaflet.markercluster instalados via NPM e servidos
 * diretamente pelo Express a partir de node_modules -- NENHUM arquivo de
 * biblioteca e carregado por CDN externo. Isso evita o erro "Nao foi
 * possivel carregar a biblioteca do mapa", comum em redes corporativas que
 * bloqueiam dominios de CDN. Requer que as dependencias tenham sido
 * instaladas com "npm install" (ver package.json / README). */
const LEAFLET_DIST = path.join(__dirname, "node_modules", "leaflet", "dist");
const LEAFLET_CLUSTER_DIST = path.join(
  __dirname,
  "node_modules",
  "leaflet.markercluster",
  "dist",
);
try {
  if (!fs.existsSync(path.join(LEAFLET_DIST, "leaflet.js"))) {
    console.warn(
      "[BOOT] node_modules/leaflet nao encontrado ou incompleto. Rode 'npm install' " +
        "(dependencias: leaflet, leaflet.markercluster) para o mapa funcionar.",
    );
  }
  if (
    !fs.existsSync(path.join(LEAFLET_CLUSTER_DIST, "leaflet.markercluster.js"))
  ) {
    console.warn(
      "[BOOT] node_modules/leaflet.markercluster nao encontrado ou incompleto. Rode 'npm install'.",
    );
  }
  app.use("/vendor/leaflet", express.static(LEAFLET_DIST));
  app.use("/vendor/leaflet.markercluster", express.static(LEAFLET_CLUSTER_DIST));
  console.log(
    "[BOOT] Assets locais do Leaflet configurados em /vendor/leaflet e /vendor/leaflet.markercluster (sem dependencia de CDN externo).",
  );
} catch (err) {
  console.error(
    "[BOOT] Falha ao configurar assets locais do Leaflet. O mapa nao vai funcionar ate 'npm install' ser executado.",
    err,
  );
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  /* NOTA (mapa): script-src e style-src permanecem restritos a 'self', ja
   * que a biblioteca do mapa (Leaflet) e servida localmente pelo Express
   * (ver /vendor/leaflet e /vendor/leaflet.markercluster) -- nenhum script
   * externo e carregado. img-src e connect-src precisam liberar os
   * provedores de tiles/geocodificacao (imagens de mapa e busca de
   * endereco), que continuam sendo servicos externos por natureza. */
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://*.tile.opentopomap.org; " +
      "connect-src 'self' https://nominatim.openstreetmap.org;",
  );
  if (CONFIG.NODE_ENV === "production")
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains",
    );
  next();
});

/* ### REGIAO: API - POSTGRESQL (GENERICO, USADO PELA TELA DE SELECAO DO MAPA) ### */
app.get("/api/db/tables", async (req, res) => {
  try {
    const tables = await listUserTables();
    res.json({ tables });
  } catch (err) {
    logEvent("error", "db", "Falha ao listar tabelas", { error: err.message });
    res.status(500).json({
      error: "Nao foi possivel conectar ou listar as tabelas: " + err.message,
    });
  }
});

app.get("/api/db/tables/:tableName/preview", async (req, res) => {
  try {
    const { tableName } = req.params;
    sanitizeIdentifierOrThrow(tableName, "tabela");
    const columns = await getTableColumns(tableName);
    if (columns.length === 0)
      return res.status(404).json({ error: "Tabela nao encontrada." });
    const rowCount = await getTableRowCount(tableName);
    const rows = await previewTable(tableName, 10);
    res.json({ columns, rowCount, rows });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

/* ### REGIAO: API - MAPA DE EMPREENDIMENTOS ###
 * A fonte de dados do mapa (schema + tabela + coluna espacial PostGIS) NAO
 * fica fixa em uma tabela: o usuario escolhe na tela, e a escolha fica salva
 * em app_settings. Para descobrir quais colunas sao espaciais, usamos as
 * views de catalogo do proprio PostGIS (geometry_columns / geography_columns),
 * que listam automaticamente TODAS as colunas geometry/geography do banco,
 * em qualquer schema/tabela -- nao precisamos adivinhar nomes de coluna.
 *
 * Os demais campos (titulo, status, municipio etc.) continuam usando a
 * resolucao por candidatos, agora aplicada a tabela que o usuario escolheu. */
const MAP_CONFIG_KEY = "map_data_source";
/* Fonte padrao do mapa: SELECT * FROM public.predio_caixao, coluna espacial "geom".
 * Usada apenas quando o usuario ainda nao configurou nenhuma fonte em app_settings
 * (tela de configuracao do mapa). Se a coluna configurada deixar de ser valida
 * (ex: tabela renomeada), o endpoint /api/mapa volta a pedir configuracao. */
const DEFAULT_MAP_CONFIG = {
  schema: "public",
  table: "predio_caixao",
  column: "geom",
};
const MAP_FIELD_CANDIDATES = {
  /* "name" tem prioridade porque tabelas geradas a partir de shapefile/KML
   * (caso de "predio_caixao") normalmente trazem colunas em ingles. */
  titulo: ["name", "nome", "titulo", "empreendimento", "nome_empreendimento"],
  layer: ["layer", "camada"],
  municipio: ["municipio", "cidade"],
  status: ["status", "situacao_obra", "etapa"],
  modalidade: ["modalidade", "programa"],
  destinacao: ["destinacao", "destinação", "destinacao_unidades"],
  situacao: ["situacao", "situacao_atual"],
  gestor: ["gestor", "responsavel", "gestor_responsavel"],
  construtora: ["construtora", "empresa", "empreendimento_empresa"],
  valor: ["valor", "valor_total", "valor_investimento"],
  percentual_execucao: [
    "percentual_execucao",
    "percentual_obra",
    "percentual_conclusao",
    "andamento",
  ],
  ultima_atualizacao: [
    "ultima_atualizacao",
    "atualizado_em",
    "updated_at",
    "data_atualizacao",
  ],
  autorizado: ["autorizado"],
};
/* A interface do mapa expoe apenas 3 filtros: Destinacao e Layer (selecao
 * exata, via dropdown) e Name (busca parcial, via ILIKE sobre a coluna
 * resolvida em "titulo"). */
const MAP_EXACT_FILTER_FIELDS = ["destinacao", "layer"];

/* Lista todas as colunas espaciais (geometry/geography) que o PostGIS conhece
 * no banco inteiro, em qualquer schema/tabela -- e a fonte usada para o
 * usuario escolher "tabela + coluna" na tela. */
async function listSpatialColumns() {
  const ext = await pool.query(
    `SELECT 1 FROM pg_extension WHERE extname = 'postgis';`,
  );
  if (ext.rows.length === 0) {
    const err = new Error(
      "A extensao PostGIS nao parece estar habilitada neste banco (CREATE EXTENSION postgis).",
    );
    err.httpStatus = 400;
    throw err;
  }
  const { rows } = await pool.query(`
    SELECT f_table_schema AS schema, f_table_name AS "table", f_geometry_column AS "column",
           'geometry' AS kind, srid, type
    FROM geometry_columns
    UNION ALL
    SELECT f_table_schema AS schema, f_table_name AS "table", f_geography_column AS "column",
           'geography' AS kind, srid, type
    FROM geography_columns
    ORDER BY 1, 2, 3;
  `);
  return rows;
}

async function getMapConfig() {
  const saved = await getAppSetting(MAP_CONFIG_KEY);
  return saved || DEFAULT_MAP_CONFIG;
}

/* Reconfirma que schema/tabela/coluna salvos ainda apontam para uma coluna
 * espacial de verdade (protege contra configuracao desatualizada, ex: coluna
 * removida ou tabela recriada). */
async function resolveConfiguredSpatialColumn(config) {
  if (!config || !config.schema || !config.table || !config.column) return null;
  const spatialCols = await listSpatialColumns();
  return (
    spatialCols.find(
      (c) =>
        c.schema === config.schema &&
        c.table === config.table &&
        c.column === config.column,
    ) || null
  );
}

/* Converte a coluna espacial para latitude/longitude em WGS84 (EPSG:4326).
 * "geography" ja e sempre WGS84; "geometry" pode estar em outro SRID e
 * precisa de ST_Transform antes de extrair X/Y.
 *
 * IMPORTANTE: ST_X()/ST_Y() so aceitam geometria do tipo Point -- se a
 * coluna guardar Polygon/MultiPolygon (ex: contorno de um predio, como em
 * "predio_caixao") elas retornam NULL (ou erro, dependendo da versao do
 * PostGIS), e nenhum registro aparece no mapa. Por isso extraimos sempre um
 * ponto representativo com ST_PointOnSurface antes de pegar as coordenadas:
 * para um Point ele devolve o proprio ponto; para Polygon/MultiPolygon/Line
 * devolve um ponto garantidamente sobre a geometria (melhor que centroide,
 * que pode cair fora de poligonos concavos). ST_Force2D remove a dimensao Z
 * (comum em geometrias exportadas do Caixa/CEHAB) para evitar problemas com
 * funcoes do GEOS que esperam 2D.
 */
function buildLatLngExpr(spatialCol, alias) {
  const colRef = format("%I.%I", alias, spatialCol.column);
  let geomExpr;
  if (spatialCol.kind === "geography") {
    geomExpr = colRef + "::geometry";
  } else if (
    spatialCol.srid &&
    Number(spatialCol.srid) !== 4326 &&
    Number(spatialCol.srid) !== 0
  ) {
    geomExpr = format("ST_Transform(%s, 4326)", colRef);
  } else {
    geomExpr = colRef;
  }
  const pointExpr = format("ST_PointOnSurface(ST_Force2D(%s))", geomExpr);
  /* Geometria completa (para Polygon/MultiPolygon) em GeoJSON, na mesma
   * normalizacao ja usada acima para o ponto representativo: reprojetada
   * para WGS84 (ST_Transform, quando necessario) e com ST_Force2D (remove
   * a dimensao Z). Nao ha simplificacao nem geracao de geometria nova -- e a
   * mesma geometria gravada no banco, apenas convertida para o formato que o
   * Leaflet consegue desenhar (GeoJSON). Usada para exibir o poligono do
   * empreendimento permanentemente no mapa (Problema 2). */
  const force2dExpr = format("ST_Force2D(%s)", geomExpr);
  return {
    latSql: format("ST_Y(%s)", pointExpr),
    lngSql: format("ST_X(%s)", pointExpr),
    geomGeoJsonSql: format("ST_AsGeoJSON(%s)", force2dExpr),
  };
}

async function resolveMapColumns(schema, table) {
  const realCols = await getSchemaTableColumns(schema, table);
  const realColsLower = realCols.map((c) => c.toLowerCase());
  const resolved = {};
  Object.entries(MAP_FIELD_CANDIDATES).forEach(([logical, candidates]) => {
    const match = candidates.find((c) =>
      realColsLower.includes(c.toLowerCase()),
    );
    resolved[logical] = match
      ? realCols[realColsLower.indexOf(match.toLowerCase())]
      : null;
  });
  return resolved;
}

function buildMapFilterClause(query, cols, alias) {
  const filters = [];
  if (cols.autorizado)
    filters.push(format("%I.%I = true", alias, cols.autorizado));
  /* Destinacao e Layer: selecao exata (dropdown na interface). */
  MAP_EXACT_FILTER_FIELDS.forEach((f) => {
    if (query[f] && cols[f])
      filters.push(format("%I.%I = %L", alias, cols[f], query[f]));
  });
  /* Name: busca parcial (contains) sobre a coluna resolvida em "titulo". */
  if (query.name && cols.titulo)
    filters.push(
      format("%I.%I ILIKE %L", alias, cols.titulo, "%" + query.name + "%"),
    );
  return filters.join(" AND ");
}

/* ---- Configuracao da fonte de dados (tabela + coluna espacial) ---- */
app.get("/api/mapa/fontes", async (req, res) => {
  try {
    const fontes = await listSpatialColumns();
    res.json({ fontes });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

app.get("/api/mapa/config", async (req, res) => {
  try {
    const config = await getMapConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mapa/config", async (req, res) => {
  try {
    const { schema, table, column } = req.body || {};
    if (!schema || !table || !column)
      return res
        .status(400)
        .json({ error: "Informe schema, tabela e coluna." });
    const spatialCol = await resolveConfiguredSpatialColumn({
      schema,
      table,
      column,
    });
    if (!spatialCol)
      return res.status(400).json({
        error:
          "Essa coluna nao e uma coluna espacial (geometry/geography) valida.",
      });
    await setAppSetting(MAP_CONFIG_KEY, { schema, table, column });
    logEvent("info", "mapa", "Fonte de dados do mapa configurada", {
      schema,
      table,
      column,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

/* ---- Dados do mapa ---- */
app.get("/api/mapa", async (req, res) => {
  console.log("[mapa] GET /api/mapa - filtros recebidos:", req.query);
  try {
    const config = await getMapConfig();
    if (!config) {
      console.warn("[mapa] Nenhuma fonte de dados configurada ainda.");
      return res.status(409).json({
        needsConfig: true,
        error: "Nenhuma fonte de dados configurada para o mapa ainda.",
      });
    }
    const spatialCol = await resolveConfiguredSpatialColumn(config);
    if (!spatialCol) {
      console.warn(
        "[mapa] Fonte configurada nao e mais uma coluna espacial valida:",
        config,
      );
      return res.status(409).json({
        needsConfig: true,
        error:
          "A fonte de dados configurada nao e mais uma coluna espacial valida. Selecione novamente.",
      });
    }
    console.log(
      `[mapa] Fonte: ${config.schema}.${config.table}.${config.column} (${spatialCol.kind}, SRID ${spatialCol.srid})`,
    );

    const alias = "t";
    const cols = await resolveMapColumns(config.schema, config.table);
    console.log("[mapa] Colunas resolvidas:", cols);
    const { latSql, lngSql, geomGeoJsonSql } = buildLatLngExpr(spatialCol, alias);
    console.log(
      "[mapa] Conversao de geometria -> lat/lng:",
      `lat=${latSql}`,
      `lng=${lngSql}`,
    );
    const whereParts = [format("%I.%I IS NOT NULL", alias, spatialCol.column)];
    const extraWhere = buildMapFilterClause(req.query, cols, alias);
    if (extraWhere) whereParts.push(extraWhere);

    const selectParts = [
      latSql + " AS latitude",
      lngSql + " AS longitude",
      geomGeoJsonSql + " AS geom_geojson",
    ];
    Object.entries(cols).forEach(([logical, real]) => {
      if (real) selectParts.push(format("%I.%I AS %I", alias, real, logical));
    });

    const sql =
      "SELECT " +
      selectParts.join(", ") +
      " FROM " +
      format("%I.%I", config.schema, config.table) +
      " AS " +
      format("%I", alias) +
      " WHERE " +
      whereParts.join(" AND ") +
      " LIMIT 20000;";
    console.log("[mapa] SQL:", sql);
    const { rows } = await pool.query(sql);
    console.log(`[mapa] ${rows.length} linha(s) retornada(s) pelo banco.`);
    const items = rows
      .map((r) => {
        const { geom_geojson, ...rest } = r;
        /* Geometria completa (para exibir o poligono permanente no mapa --
         * Problema 2). So repassamos ao frontend quando o tipo for Polygon
         * ou MultiPolygon; para colunas que guardam apenas Point (ex: um
         * pino simples), nao ha poligono a desenhar e "geometry" fica null. */
        let geometry = null;
        if (geom_geojson) {
          try {
            const parsed = JSON.parse(geom_geojson);
            if (parsed && (parsed.type === "Polygon" || parsed.type === "MultiPolygon")) {
              geometry = parsed;
            }
          } catch (e) {
            logEvent("error", "mapa", "Falha ao parsear geom_geojson de um registro", {
              error: e.message,
            });
          }
        }
        return {
          ...rest,
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
          geometry,
        };
      })
      .filter(
        (r) =>
          Number.isFinite(r.latitude) &&
          Number.isFinite(r.longitude) &&
          Math.abs(r.latitude) <= 90 &&
          Math.abs(r.longitude) <= 180,
      );
    const discarded = rows.length - items.length;
    if (discarded > 0)
      console.warn(
        `[mapa] ${discarded} registro(s) descartado(s) por coordenadas invalidas/nulas apos a conversao de geometria.`,
      );
    console.log(`[mapa] ${items.length} registro(s) validos enviados ao mapa.`);
    res.json({ count: items.length, items, columns: cols, source: config });
  } catch (err) {
    console.error("[mapa] Falha ao carregar /api/mapa:", err);
    logEvent("error", "mapa", "Falha ao carregar /api/mapa", {
      error: err.message,
    });
    res.status(err.httpStatus || 500).json({
      error: "Nao foi possivel carregar os dados do mapa: " + err.message,
    });
  }
});

app.get("/api/mapa/filtros", async (req, res) => {
  try {
    const config = await getMapConfig();
    if (!config) return res.json({});
    const spatialCol = await resolveConfiguredSpatialColumn(config);
    if (!spatialCol) return res.json({});
    const cols = await resolveMapColumns(config.schema, config.table);
    const filterable = MAP_EXACT_FILTER_FIELDS.filter((f) => cols[f]);
    const out = {};
    for (const f of filterable) {
      const sql =
        "SELECT DISTINCT " +
        format("%I", cols[f]) +
        " AS value FROM " +
        format("%I.%I", config.schema, config.table) +
        " WHERE " +
        format("%I IS NOT NULL", cols[f]) +
        " ORDER BY 1 LIMIT 300;";
      const { rows } = await pool.query(sql);
      out[f] = rows.map((r) => r.value);
    }
    res.json(out);
  } catch (err) {
    logEvent("error", "mapa", "Falha ao carregar /api/mapa/filtros", {
      error: err.message,
    });
    res
      .status(500)
      .json({ error: "Nao foi possivel carregar as opcoes de filtro." });
  }
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({ ok: true, db: "up" });
  } catch (err) {
    res.status(503).json({ ok: false, db: "down", error: err.message });
  }
});

/* ### REGIAO: FRONTEND (HTML + CSS + JS EMBUTIDOS) ### */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Mapa de Empreendimentos</title>
<!-- Biblioteca do mapa (Leaflet + Leaflet.markercluster): arquivos LOCAIS,
     instalados via NPM e servidos pelo proprio Express (/vendor/leaflet e
     /vendor/leaflet.markercluster) -- NENHUM script/CSS e carregado de CDN
     externo. Isso evita o erro "Nao foi possivel carregar a biblioteca do
     mapa", comum em redes corporativas que bloqueiam dominios de CDN. -->
<link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
<link rel="stylesheet" href="/vendor/leaflet.markercluster/MarkerCluster.css" />
<link rel="stylesheet" href="/vendor/leaflet.markercluster/MarkerCluster.Default.css" />
<style>
:root {
  --bg: #f4f6f9; --surface: #ffffff; --text: #1a2233; --muted: #667085;
  --border: #e3e7ee; --primary: #2f6fed; --primary-dark: #1f52c0;
  --success: #1a9c5c; --danger: #d1453b; --warn: #b8790f; --info: #2563eb;
  --radius: 10px; --shadow: 0 1px 3px rgba(20,30,60,0.08), 0 1px 2px rgba(20,30,60,0.06);
}
* { box-sizing: border-box; }
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
button { font-family: inherit; cursor: pointer; }
input, select { font-family: inherit; }
.hidden { display: none !important; }

.topbar { display:flex; align-items:center; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
.topbar .brand { font-weight: 700; font-size: 16px; display:flex; align-items:center; gap:8px; }
.topbar .brand .dot { width:8px; height:8px; border-radius:50%; background: var(--primary); }
.page { padding: 24px; max-width: 1400px; margin: 0 auto; }

.field { margin-bottom: 14px; }
.field label { display:block; font-size: 12px; font-weight:600; color: var(--muted); margin-bottom: 6px; }
.field input, .field select { width:100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 14px; }
.btn { border:none; border-radius: 8px; padding: 10px 16px; font-size: 14px; font-weight:600; transition: transform .05s, opacity .15s; }
.btn:active { transform: scale(0.98); }
.btn-primary { background: var(--primary); color: white; }
.btn-primary:hover { background: var(--primary-dark); }
.btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.errorMsg { background: rgba(209,69,59,0.1); color: var(--danger); border: 1px solid rgba(209,69,59,0.3); padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }

h2 { font-size: 18px; margin: 0 0 4px; }
.subtitle { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
.small { font-size: 12px; color: var(--muted); }

table.dataPreview { width:100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
table.dataPreview th, table.dataPreview td { border: 1px solid var(--border); padding: 6px 8px; text-align:left; white-space: nowrap; max-width: 220px; overflow:hidden; text-overflow: ellipsis; }
table.dataPreview th { background: var(--bg); position: sticky; top:0; }
.tablePreviewWrap { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }

.tableList { max-height: 220px; overflow:auto; border: 1px solid var(--border); border-radius: 8px; }
.tableListItem { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; display:flex; justify-content:space-between; cursor:pointer; }
.tableListItem:last-child { border-bottom:none; }
.tableListItem:hover { background: var(--bg); }
.tableListItem.selected { background: rgba(47,111,237,0.1); font-weight:600; }
.searchBox { margin-bottom: 10px; }

.footerActions { display:flex; justify-content:space-between; margin-top: 22px; }

.toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface); border:1px solid var(--border); box-shadow: var(--shadow); padding: 12px 16px; border-radius: 8px; font-size: 13px; max-width: 320px; z-index: 999; }
.toast.success { border-left: 4px solid var(--success); }
.toast.error { border-left: 4px solid var(--danger); }
.toast.warn { border-left: 4px solid var(--warn); }

.spinner { width:14px; height:14px; border: 2px solid rgba(0,0,0,.15); border-top-color: var(--primary); border-radius: 50%; display:inline-block; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* ===== MAPA DE EMPREENDIMENTOS ===== */
.mapWrap { display:grid; grid-template-columns: 280px 1fr; gap:14px; height: calc(100vh - 200px); min-height: 520px; }
.mapSidebar { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:14px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; }
.mapSidebar h3 { margin:0 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.mapFilterField { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; }
.mapFilterField label { font-size:12px; color:var(--muted); }
.mapFilterField input, .mapFilterField select { padding:7px 9px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); font-size:13px; }
.mapStatsGrid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
.mapStatChip { border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
.mapStatChip .val { font-size:18px; font-weight:700; }
.mapStatChip .lbl { font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px; }
.mapStatDot { width:9px; height:9px; border-radius:50%; display:inline-block; flex-shrink:0; }
.mapMain { position:relative; border:1px solid var(--border); border-radius: var(--radius); overflow:hidden; background: var(--surface); }
#mapCanvas { position:absolute; inset:0; }
.mapToolbar { position:absolute; top:10px; left:10px; right:10px; z-index:5; display:flex; gap:8px; align-items:flex-start; flex-wrap:wrap; pointer-events:none; }
.mapToolbar > * { pointer-events:auto; }
.mapSearchBox { flex:1; min-width:220px; max-width:360px; background:var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow: var(--shadow); display:flex; align-items:center; padding:0 10px; }
.mapSearchBox input { border:none; background:transparent; padding:9px 6px; font-size:13px; flex:1; color:var(--text); outline:none; }
.mapLayerSwitcher { background:var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow: var(--shadow); display:flex; gap:2px; padding:4px; }
.mapLayerBtn { border:none; background:transparent; padding:6px 9px; border-radius:7px; font-size:12px; color:var(--text); white-space:nowrap; }
.mapLayerBtn.active { background: var(--primary); color:#fff; }
.mapCtrlBtn { background:var(--surface); border:1px solid var(--border); border-radius:8px; width:34px; height:34px; box-shadow: var(--shadow); font-size:15px; display:flex; align-items:center; justify-content:center; }
.mapCtrlGroup { position:absolute; bottom:24px; right:10px; z-index:5; display:flex; flex-direction:column; gap:6px; }
.mapLegend { position:absolute; bottom:16px; left:10px; z-index:5; background:var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow: var(--shadow); padding:10px 12px; font-size:12px; max-width:220px; max-height:220px; overflow-y:auto; }
.mapLegend .legendRow { display:flex; align-items:center; gap:7px; margin:3px 0; }
.mapLegend .legendDot { width:11px; height:11px; border-radius:3px; flex-shrink:0; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15); }
/* Poligonos do mapa (destinacao): transicoes suaves de borda/preenchimento no
 * hover/selecao e cursor de "clicavel", sem depender de re-render. */
.leaflet-interactive { transition: stroke-width 0.12s ease-out, stroke-opacity 0.12s ease-out, fill-opacity 0.12s ease-out; cursor: pointer; }
.mapOverlayState { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px; background:var(--bg); z-index:8; text-align:center; padding:20px; }
.mapOverlayState.hidden { display:none; }
.mapCoordReadout { position:absolute; bottom:16px; right:180px; z-index:5; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:5px 9px; font-size:11px; color:var(--muted); }
.leaflet-popup-content-wrapper { background: var(--surface) !important; color: var(--text) !important; border-radius: 10px !important; box-shadow: var(--shadow) !important; padding:0 !important; }
.leaflet-popup-content { margin:0 !important; width:auto !important; }
.leaflet-popup-tip { background: var(--surface) !important; }
.mapPopupCard { padding:12px 14px; min-width:220px; }
.mapPopupCard h4 { margin:0 0 6px; font-size:14px; }
.mapPopupCard .row { display:flex; justify-content:space-between; gap:10px; font-size:12px; padding:2px 0; border-bottom:1px dashed var(--border); }
.mapPopupCard .row:last-of-type { border-bottom:none; }
.mapPopupCard .row .k { color:var(--muted); }
.mapStatusBadge { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; }
@media (max-width: 900px) { .mapWrap { grid-template-columns: 1fr; height:auto; } .mapMain { height:520px; } }
</style>
</head>
<body>

<div class="topbar">
  <div class="brand"><span class="dot"></span> Mapa de Empreendimentos</div>
</div>

<div class="page">

  <!-- ===== TELA DE SELECAO: aparece antes do mapa abrir ===== -->
  <div id="mapSelectView">
    <h2>Mapa</h2>
    <p class="subtitle">Escolha a tabela do banco e a coluna de localizacao para visualizar os registros no mapa.</p>
    <div id="mapSelectError" class="errorMsg hidden"></div>

    <div id="mapSelectStepTable">
      <div class="field"><label>Passo 1 de 2 &mdash; Tabela de origem</label><input class="searchBox" id="mapSelectTableSearch" placeholder="Pesquisar tabela..." /><div class="tableList" id="mapSelectTableList"></div></div>
      <div class="tablePreviewWrap hidden" id="mapSelectPreviewWrap"><table class="dataPreview" id="mapSelectPreviewTable"></table></div>
    </div>

    <div id="mapSelectStepColumn" class="hidden">
      <p class="small">Tabela selecionada: <strong id="mapSelectSelectedTable"></strong></p>
      <label>Passo 2 de 2 &mdash; Coluna responsavel pela localizacao</label>
      <div class="tableList" id="mapSelectColumnList" style="margin-top:6px"></div>
      <p class="small hidden" id="mapSelectNoSpatial" style="margin-top:8px">Nenhuma coluna espacial (geometry/geography) foi encontrada nessa tabela. Volte e escolha outra tabela.</p>
      <div class="footerActions" style="margin-top:14px">
        <button class="btn btn-secondary" id="mapSelectBackBtn">Voltar</button>
        <button class="btn btn-primary" id="mapOpenBtn" disabled>Abrir mapa</button>
      </div>
    </div>
  </div>

  <!-- ===== MAPA: so aparece depois de escolher tabela + coluna ===== -->
  <div id="mapView" class="hidden">
    <div class="mapWrap">
      <div class="mapSidebar">
        <div>
          <h3>Filtros</h3>
          <div class="mapFilterField"><label>Name</label><input id="mapFilterName" placeholder="Buscar por nome..." /></div>
          <div class="mapFilterField"><label>Destinacao</label><select id="mapFilterDestinacao"><option value="">Todas</option></select></div>
          <div class="mapFilterField"><label>Layer</label><select id="mapFilterLayer"><option value="">Todas</option></select></div>
          <button class="btn btn-secondary" id="mapClearFiltersBtn" style="width:100%">Limpar filtros</button>
        </div>
        <div>
          <h3>Estatisticas</h3>
          <div class="mapStatsGrid" id="mapStatsGrid"><div class="mapStatChip"><div class="val" id="mapStatTotal">-</div><div class="lbl">Total</div></div></div>
        </div>
      </div>
      <div class="mapMain">
        <div id="mapCanvas" role="application" aria-label="Mapa interativo"></div>
        <div class="mapToolbar">
          <div class="mapSearchBox">
            <span aria-hidden="true">&#128269;</span>
            <input id="mapGeocodeInput" placeholder="Buscar endereco ou local..." aria-label="Buscar endereco" />
          </div>
          <div class="mapLayerSwitcher" id="mapLayerSwitcher" role="group" aria-label="Camada do mapa"></div>
        </div>
        <div class="mapCtrlGroup">
          <button class="mapCtrlBtn" id="mapZoomInBtn" title="Aumentar zoom" aria-label="Aumentar zoom">+</button>
          <button class="mapCtrlBtn" id="mapZoomOutBtn" title="Diminuir zoom" aria-label="Diminuir zoom">&minus;</button>
          <button class="mapCtrlBtn" id="mapLocateBtn" title="Minha localizacao" aria-label="Minha localizacao">&#128205;</button>
          <button class="mapCtrlBtn" id="mapResetBtn" title="Centralizar resultados" aria-label="Centralizar resultados">&#8635;</button>
          <button class="mapCtrlBtn" id="mapFullscreenBtn" title="Tela cheia" aria-label="Tela cheia">&#9974;</button>
          <button class="mapCtrlBtn" id="mapChangeSourceBtn" title="Trocar tabela/coluna de localizacao" aria-label="Trocar fonte de dados">&#9881;</button>
        </div>
        <div class="mapLegend" id="mapLegend"><strong style="font-size:11px">Legenda</strong></div>
        <div class="mapCoordReadout" id="mapCoordReadout"></div>
        <div class="mapOverlayState hidden" id="mapLoadingState"><div class="spinner"></div><p class="small">Carregando registros...</p></div>
        <div class="mapOverlayState hidden" id="mapErrorState"><p id="mapErrorMsg">Nao foi possivel carregar o mapa.</p><button class="btn btn-primary" id="mapRetryBtn">Tentar novamente</button></div>
        <div class="mapOverlayState hidden" id="mapEmptyState"><p>Nenhum registro encontrado para os filtros selecionados.</p></div>
      </div>
    </div>
  </div>

</div>

<div id="toastRoot"></div>

<script src="/vendor/leaflet/leaflet.js"></script>
<script src="/vendor/leaflet.markercluster/leaflet.markercluster.js"></script>

<script>
(function () {
  'use strict';

  /* ==================== ESTADO GLOBAL ==================== */
  var state = { tables: [] };

  /* ==================== UTILITARIOS ==================== */
  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function showEl(id) { $(id).classList.remove('hidden'); }
  function hideEl(id) { $(id).classList.add('hidden'); }
  function setError(id, msg) {
    var el = $(id);
    if (!msg) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.textContent = msg;
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(msg, type) {
    var el = document.createElement('div'); el.className = 'toast ' + (type || 'success'); el.textContent = msg;
    $('toastRoot').appendChild(el); setTimeout(function () { el.remove(); }, 5000);
  }

  function api(method, url, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || ('Erro HTTP ' + res.status)); err.data = data; err.status = res.status; throw err; }
        return data;
      });
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ================================================================
   * FUNCOES UTILITARIAS COMPARTILHADAS (usadas pela tela de selecao)
   * ================================================================ */
  function renderPreviewTable(tableId, headers, rows) {
    var table = $(tableId); if (!table) return;
    var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (row) {
      return '<tr>' + row.map(function (cell) { return '<td>' + escapeHtml(cell == null ? '' : cell) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    table.innerHTML = thead + tbody;
  }

  function renderTableList(containerId, tables, onSelect) {
    var container = $(containerId); if (!container) return;
    container.innerHTML = tables.map(function (t) {
      var name = t.table_name || t;
      return '<div class="tableListItem" data-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '<span class="small">' + (t.row_count != null ? t.row_count + ' regs' : '') + '</span></div>';
    }).join('');
    qsa('.tableListItem', container).forEach(function (item) {
      item.addEventListener('click', function () { onSelect(this.getAttribute('data-name')); });
    });
  }

  function selectFromList(containerId, name) {
    var container = $(containerId); if (!container) return;
    qsa('.tableListItem', container).forEach(function (item) {
      item.classList.toggle('selected', item.getAttribute('data-name') === name);
    });
  }

  /* ==================== MAPA DE EMPREENDIMENTOS ==================== */
  // Cores centralizadas por DESTINACAO (substitui o antigo esquema por
  // status): cada valor distinto da coluna "destinacao" recebe uma cor viva
  // e elegante, gerada automaticamente de forma DETERMINISTICA (mesma
  // destinacao sempre produz a mesma cor, em qualquer carregamento da
  // pagina, sem depender de ordem de chegada dos dados). Nao ha mais mapa
  // fixo de cores: tudo -- poligonos, popup, legenda e estatisticas -- usa
  // exclusivamente a funcao getDestinationColor() abaixo.
  var DESTINATION_COLOR_CACHE = {};
  var DESTINATION_HUE_STEP = 137.508; // angulo aureo: espalha os tons de forma visualmente distinta

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    var toHex = function (v) {
      var hx = Math.round((v + m) * 255).toString(16);
      return hx.length === 1 ? '0' + hx : hx;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  /* Cor consistente e determinada a partir do texto da destinacao: mesmo
   * texto -> mesmo tom (hue) sempre, com saturacao/luminosidade fixas numa
   * faixa "viva porem elegante" (nao neon, nao pastel). Qualquer destinacao
   * nova -- ainda nao vista -- recebe automaticamente uma cor propria na
   * primeira vez que passa por aqui, sem precisar de cadastro manual. */
  function getDestinationColor(destinacao) {
    var key = String(destinacao || '').trim();
    if (!key) return '#94a3b8';
    var normalized = key.toLowerCase();
    if (!DESTINATION_COLOR_CACHE[normalized]) {
      var h = hashString(normalized);
      var hue = (h * DESTINATION_HUE_STEP) % 360;
      var saturation = 62 + (h % 15); // 62% - 76%
      var lightness = 42 + (h % 11); // 42% - 52%
      DESTINATION_COLOR_CACHE[normalized] = hslToHex(hue, saturation, lightness);
    }
    return DESTINATION_COLOR_CACHE[normalized];
  }

  // Definicoes de camada (basemap) para o Leaflet. "url" usa o padrao {s}
  // (subdominio) do proprio Leaflet; quando o provedor nao tem subdominios
  // (ex: Esri), "subdomains" fica vazio. Apenas os TILES (imagens de mapa)
  // vem de servicos externos -- a BIBLIOTECA do mapa em si (Leaflet) e 100%
  // local, ver /vendor/leaflet no <head>.
  var MAP_LAYER_DEFS = [
    { id: 'osm', label: 'Mapa', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], attribution: '&copy; OpenStreetMap', maxZoom: 19 },
    { id: 'positron', label: 'Claro', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], attribution: '&copy; CARTO', maxZoom: 20 },
    { id: 'dark', label: 'Escuro', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], attribution: '&copy; CARTO', maxZoom: 20 },
    { id: 'satellite', label: 'Satelite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', subdomains: [], attribution: 'Esri', maxZoom: 19 },
    { id: 'topo', label: 'Relevo', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], attribution: '&copy; OpenTopoMap', maxZoom: 17 },
  ];

  var MapModule = (function () {
    var map = null, tileLayer = null, polygonLayer = null, currentLayerId = 'positron';
    var abortController = null, lastItems = [];
    var selectedPolygonLayer = null; // garante que apenas 1 poligono fique com o destaque de "selecionado"
    var selTable = null, selColumn = null;

    /* Extrai uma mensagem de erro sempre legivel. Usada em todo o modulo para
     * evitar o problema de exibir literalmente "undefined" quando o valor
     * rejeitado/lancado nao e um Error "de verdade" (ex: string solta,
     * objeto sem campo message, ou throw sem valor nenhum). */
    function getErrorMessage(err) {
      if (err === undefined || err === null) return 'Erro desconhecido (nenhum detalhe informado).';
      if (typeof err === 'string') return err;
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === 'object' && err.message) return String(err.message);
      try { return JSON.stringify(err); } catch (e) { return String(err); }
    }

    /* ================================================================
     * ENTRADA
     * Sempre mostra a tela de selecao primeiro: o mapa em si so aparece
     * depois que o usuario escolhe explicitamente a tabela e a coluna de
     * localizacao (geometry/geography). Nada e assumido automaticamente.
     * ================================================================ */
    function enter() {
      console.log('[map] Painel do mapa aberto (tela de selecao de fonte).');
      showEl('mapSelectView'); hideEl('mapView');
      selTable = null; selColumn = null;
      setError('mapSelectError', null);
      hideEl('mapSelectPreviewWrap'); hideEl('mapSelectStepColumn'); showEl('mapSelectStepTable');
      $('mapOpenBtn').disabled = true;
      loadSelectTables();
    }

    function backToSelect() {
      hideEl('mapView');
      enter();
    }

    /* ---------------- Passo 1: escolher a tabela ---------------- */
    function loadSelectTables() {
      api('GET', '/api/db/tables').then(function (data) {
        state.tables = data.tables;
        renderSelectTableList(state.tables);
      }).catch(function (err) {
        console.error('[map] Falha ao listar tabelas do banco:', err);
        setError('mapSelectError', getErrorMessage(err));
      });
    }

    function renderSelectTableList(tables) {
      renderTableList('mapSelectTableList', tables, function (name) {
        selectFromList('mapSelectTableList', name);
        selTable = name; selColumn = null; $('mapOpenBtn').disabled = true;
        api('GET', '/api/db/tables/' + name + '/preview').then(function (data) {
          var headers = data.columns.map(function (c) { return c.column_name; });
          var rows = data.rows.slice(0, 5).map(function (r) { return headers.map(function (h) { return r[h]; }); });
          showEl('mapSelectPreviewWrap');
          renderPreviewTable('mapSelectPreviewTable', headers, rows);
        }).catch(function () { /* preview e apenas informativo */ });
        goToColumnStep(name);
      });
    }

    $('mapSelectTableSearch').addEventListener('input', function () {
      var q = this.value.toLowerCase();
      renderSelectTableList(state.tables.filter(function (t) { return t.table_name.toLowerCase().indexOf(q) >= 0; }));
    });
    $('mapSelectBackBtn').addEventListener('click', function () {
      hideEl('mapSelectStepColumn'); showEl('mapSelectStepTable');
    });

    /* ---------------- Passo 2: escolher a coluna de localizacao ---------------- */
    function goToColumnStep(tableName) {
      setError('mapSelectError', null);
      $('mapSelectSelectedTable').textContent = tableName;
      api('GET', '/api/mapa/fontes').then(function (data) {
        var cols = (data.fontes || []).filter(function (f) { return f.schema === 'public' && f.table === tableName; });
        hideEl('mapSelectStepTable'); showEl('mapSelectStepColumn');
        if (!cols.length) {
          showEl('mapSelectNoSpatial');
          $('mapSelectColumnList').innerHTML = '';
          return;
        }
        hideEl('mapSelectNoSpatial');
        renderSelectColumnList(cols);
      }).catch(function (err) {
        console.error('[map] Falha ao listar colunas espaciais da tabela ' + tableName + ':', err);
        setError('mapSelectError', getErrorMessage(err));
      });
    }

    function renderSelectColumnList(cols) {
      var container = $('mapSelectColumnList');
      container.innerHTML = cols.map(function (c) {
        return '<div class="tableListItem" data-col="' + escapeHtml(c.column) + '">' + escapeHtml(c.column) +
          '<span class="small">' + escapeHtml(c.kind) + (c.srid ? ' &middot; SRID ' + c.srid : '') + '</span></div>';
      }).join('');
      qsa('.tableListItem', container).forEach(function (item) {
        item.addEventListener('click', function () {
          selectFromList('mapSelectColumnList', item.getAttribute('data-col'));
          selColumn = item.getAttribute('data-col');
          $('mapOpenBtn').disabled = false;
        });
      });
    }

    /* ---------------- Confirmar e abrir o mapa ---------------- */
    $('mapOpenBtn').addEventListener('click', function () {
      if (!selTable || !selColumn) return;
      var btn = this; btn.disabled = true;
      setError('mapSelectError', null);
      console.log('[map] Configurando fonte de dados do mapa:', selTable, selColumn);
      api('POST', '/api/mapa/config', { schema: 'public', table: selTable, column: selColumn }).then(function () {
        hideEl('mapSelectView'); showEl('mapView');
        openMap();
      }).catch(function (err) {
        console.error('[map] Falha ao salvar a configuracao da fonte de dados:', err);
        setError('mapSelectError', getErrorMessage(err));
        btn.disabled = false;
      });
    });

    /* ================================================================
     * MAPA -- so e construido depois que a tabela + coluna sao escolhidas.
     *
     * IMPORTANTE (causa raiz do bug "Map container is already initialized"):
     * o Leaflet marca o elemento DOM usado em L.map(...) com uma propriedade
     * interna (container._leaflet_id) na primeira inicializacao. Chamar
     * L.map() de novo sobre o MESMO elemento -- por exemplo, reconstruindo o
     * mapa toda vez que o botao "Tentar novamente" e clicado -- faz o
     * Leaflet lancar exatamente esse erro. A solucao correta NAO e recriar o
     * mapa a cada tentativa: a instancia de L.map() e criada UMA UNICA VEZ
     * (guardada na variavel "map", no escopo do modulo) e reaproveitada daí
     * em diante; qualquer nova chamada de openMap() apenas reutiliza essa
     * instancia e recarrega dados/marcadores.
     * ================================================================ */
    function buildTileLayer(layerId) {
      var def = MAP_LAYER_DEFS.filter(function (l) { return l.id === layerId; })[0] || MAP_LAYER_DEFS[0];
      console.log('[map] Criando camada de tiles (basemap):', def.id);
      var opts = { attribution: def.attribution, maxZoom: def.maxZoom || 19 };
      if (def.subdomains && def.subdomains.length) opts.subdomains = def.subdomains;
      return L.tileLayer(def.url, opts);
    }

    function openMap() {
      console.log('[map] openMap() chamado. Instancia ja existe?', !!map);

      /* Mapa ja inicializado: NUNCA chamar L.map() de novo. Apenas garante
       * que o tamanho esteja correto (o container pode ter ficado oculto
       * entre uma visita e outra do painel) e recarrega filtros/dados. */
      if (map) {
        console.log('[map] Reutilizando a instancia existente do mapa (sem recriar).');
        setTimeout(function () {
          try { map.invalidateSize(); } catch (e) { console.warn('[map] invalidateSize() falhou (nao critico):', e); }
        }, 50);
        loadFilterOptions();
        loadData();
        return;
      }

      if (typeof L === 'undefined') {
        var libMsg = 'Nao foi possivel carregar a biblioteca do mapa (Leaflet). Verifique se as dependencias locais foram instaladas (npm install) e recarregue a pagina.';
        console.error('[map] ' + libMsg);
        setState('error', libMsg);
        return;
      }

      var container = $('mapCanvas');
      if (!container) {
        var domMsg = 'Elemento #mapCanvas nao encontrado no DOM.';
        console.error('[map] ' + domMsg);
        setState('error', 'Falha ao inicializar o mapa: ' + domMsg);
        return;
      }

      /* Rede de seguranca: se uma tentativa anterior deixou o container
       * marcado como "ja inicializado" pelo Leaflet (por exemplo, uma
       * excecao no meio da montagem, antes de limparmos o estado), removemos
       * essa marca residual antes de tentar de novo -- assim uma nova
       * abertura do painel (que chama openMap com map === null) sempre
       * consegue criar o L.map() com sucesso. */
      if (container._leaflet_id) {
        console.warn('[map] Container #mapCanvas tinha um _leaflet_id residual de uma tentativa anterior; limpando antes de recriar.');
        delete container._leaflet_id;
      }

      try {
        console.log('[map] Inicializando o mapa Leaflet (primeira vez nesta sessao)...');
        renderLayerSwitcher();
        map = L.map(container, { center: [-8.05, -38.5], zoom: 6.5, zoomControl: false });
        tileLayer = buildTileLayer(currentLayerId);
        tileLayer.addTo(map);
        /* Camada de poligonos: e a UNICA representacao visual dos registros
         * no mapa (os antigos circulos/marcadores foram removidos por
         * completo -- ver buildPolygonStyle/wirePolygonInteractions).
         * Adicionada diretamente ao mapa (sem agrupamento por zoom), assim
         * os poligonos permanecem visiveis em qualquer nivel de zoom, sem
         * depender de eventos 'zoom'/'zoomend'. Suporta Polygon e
         * MultiPolygon nativamente (L.geoJSON). "smoothFactor" mais alto
         * deixa os contornos com aparencia mais suave/arredondada. */
        polygonLayer = L.geoJSON(null, {
          smoothFactor: 1.5,
          style: buildPolygonStyle,
          onEachFeature: wirePolygonInteractions,
        });
        map.addLayer(polygonLayer);
        map.on('mousemove', function (e) {
          var el = $('mapCoordReadout');
          if (el) el.textContent = e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4);
        });
        wireControls();
        wireFilters();
        console.log('[map] Mapa Leaflet inicializado com sucesso.');
        /* CAUSA RAIZ do bug "marcadores somem, so aparecem durante o zoom":
         * o container #mapCanvas acabou de sair de "display:none" (classe
         * "hidden" removida logo antes de chamar openMap()) e o Leaflet mede
         * o tamanho do container no momento do L.map(...) -- antes do
         * navegador terminar o reflow -- guardando esse tamanho (errado) em
         * cache interno (this._size). Esse cache so e recalculado com um
         * invalidateSize() explicito; sem ele, todo o "pixel origin" usado
         * para posicionar tiles/marcadores fica desalinhado permanentemente,
         * o que faz os marcadores parecerem "piscar" para o lugar certo
         * durante a animacao de zoom e sumirem de novo assim que ela termina
         * (zoomend recalcula com o mesmo cache errado). O ramo de
         * reaproveitamento do mapa (bloco "if (map) {...}" acima) ja fazia
         * exatamente esse invalidateSize() -- faltava apenas aplicar o mesmo
         * tratamento aqui, na primeira inicializacao. */
        setTimeout(function () {
          try { map.invalidateSize(); } catch (e) { console.warn('[map] invalidateSize() falhou apos inicializacao (nao critico):', e); }
        }, 50);
        loadFilterOptions();
        loadData();
      } catch (err) {
        var message = getErrorMessage(err);
        console.error('[map] Falha ao inicializar o mapa:', err);
        // Desfaz qualquer estado parcial para permitir uma nova tentativa
        // real (via reabertura do painel), sem deixar o container "sujo".
        if (map) { try { map.remove(); } catch (e2) { console.warn('[map] Erro ao limpar mapa parcialmente inicializado:', e2); } }
        map = null; tileLayer = null; polygonLayer = null; selectedPolygonLayer = null;
        if (container._leaflet_id) delete container._leaflet_id;
        setState('error', 'Falha ao inicializar o mapa: ' + message);
      }
    }

    function switchLayer(layerId) {
      if (!map) { console.warn('[map] switchLayer chamado sem mapa inicializado; ignorado.'); return; }
      console.log('[map] Trocando camada de tiles para:', layerId);
      currentLayerId = layerId;
      renderLayerSwitcher();
      if (tileLayer) map.removeLayer(tileLayer);
      tileLayer = buildTileLayer(layerId);
      tileLayer.addTo(map);
    }

    function renderLayerSwitcher() {
      var el = $('mapLayerSwitcher');
      el.innerHTML = MAP_LAYER_DEFS.map(function (l) {
        return '<button type="button" class="mapLayerBtn' + (l.id === currentLayerId ? ' active' : '') + '" data-layer="' + l.id + '">' + escapeHtml(l.label) + '</button>';
      }).join('');
      qsa('.mapLayerBtn', el).forEach(function (btn) {
        btn.addEventListener('click', function () { switchLayer(this.getAttribute('data-layer')); });
      });
    }

    /* ---------------- Poligonos: estilo, hover e selecao ----------------
     * Os antigos circulos/marcadores (L.circleMarker) foram removidos por
     * completo -- o poligono e a UNICA representacao visual de cada
     * registro no mapa. Tudo abaixo e organizado em funcoes pequenas e
     * reutilizaveis (estilo base / hover / selecao / eventos), sem logica
     * duplicada entre elas. */

    // Estilo "base" (repouso) de um poligono: visual moderno (tipo Google
    // Maps/ArcGIS) -- borda mais grossa, cantos arredondados (suavizados),
    // preenchimento translucido e cor viva definida pela DESTINACAO.
    function buildPolygonStyle(feature) {
      var color = getDestinationColor(feature.properties && feature.properties.destinacao);
      return {
        color: color,
        weight: 2.5,
        opacity: 0.9,
        fillColor: color,
        fillOpacity: 0.3,
        lineJoin: 'round',
        lineCap: 'round',
      };
    }

    // Estilo aplicado enquanto o mouse esta sobre o poligono: borda um
    // pouco mais grossa e mais opaca, preenchimento levemente mais forte.
    function buildHoverStyle(baseStyle) {
      return {
        weight: baseStyle.weight + 1.5,
        opacity: 1,
        fillOpacity: Math.min(0.5, baseStyle.fillOpacity + 0.15),
      };
    }

    // Estilo do poligono SELECIONADO: borda branca de destaque (com um
    // contorno escuro por baixo, via "pane"/z-index do proprio Leaflet ao
    // trazer a camada para frente) para continuar legivel em qualquer
    // basemap, claro ou escuro.
    function buildSelectedStyle(baseStyle) {
      return {
        color: '#ffffff',
        weight: 4,
        opacity: 1,
        fillColor: baseStyle.fillColor,
        fillOpacity: Math.min(0.55, baseStyle.fillOpacity + 0.2),
      };
    }

    // Restaura o estilo correto de uma camada: o estilo de selecao (se for
    // a camada atualmente selecionada) ou o estilo base (repouso).
    function restorePolygonStyle(layer) {
      if (layer === selectedPolygonLayer) {
        layer.setStyle(buildSelectedStyle(layer._baseStyle));
      } else {
        layer.setStyle(layer._baseStyle);
      }
    }

    // Seleciona um unico poligono por vez: desfaz o destaque do poligono
    // selecionado anteriormente (se houver) e aplica o destaque no novo.
    function selectPolygon(layer) {
      if (selectedPolygonLayer && selectedPolygonLayer !== layer) {
        var previous = selectedPolygonLayer;
        previous.setStyle(previous._baseStyle);
      }
      selectedPolygonLayer = layer;
      layer.setStyle(buildSelectedStyle(layer._baseStyle));
      if (layer.bringToFront) layer.bringToFront();
    }

    // Liga os eventos de hover/clique de um poligono. Chamada uma vez por
    // feature (via onEachFeature do L.geoJSON).
    function wirePolygonInteractions(feature, layer) {
      layer._baseStyle = buildPolygonStyle(feature);
      layer.on({
        mouseover: function () {
          layer.setStyle(buildHoverStyle(layer._baseStyle));
          if (layer.bringToFront) layer.bringToFront();
        },
        mouseout: function () {
          restorePolygonStyle(layer);
        },
        click: function () {
          selectPolygon(layer);
          showPopup(feature.properties, layer);
        },
      });
    }

    /* Poligonos permanentes: reconstruidos a partir do cache de dados
     * (lastItems), entao ficam automaticamente sincronizados com os
     * filtros aplicados (Name/Destinacao/Layer) e com qualquer atualizacao
     * dos dados -- sem depender de zoom/pan. Usa a geometria
     * (Polygon/MultiPolygon) ja vinda pronta da API, sem gerar nem
     * simplificar geometria no cliente. */
    function renderPolygonsFromCache() {
      if (!polygonLayer) { console.warn('[map] renderPolygonsFromCache chamado sem polygonLayer pronta; ignorado.'); return; }
      var comGeometria = lastItems.filter(function (it) {
        return it.geometry && (it.geometry.type === 'Polygon' || it.geometry.type === 'MultiPolygon');
      });
      polygonLayer.clearLayers();
      selectedPolygonLayer = null; // as camadas antigas foram destruidas; nao ha mais selecao valida
      polygonLayer.addData({
        type: 'FeatureCollection',
        features: comGeometria.map(function (it) {
          return { type: 'Feature', geometry: it.geometry, properties: it };
        }),
      });
      console.log('[map] ' + comGeometria.length + ' poligono(s) desenhados permanentemente no mapa.');
    }

    function rowHtml(label, value) {
      if (value === null || value === undefined || value === '') return '';
      return '<div class="row"><span class="k">' + escapeHtml(label) + '</span><span>' + escapeHtml(String(value)) + '</span></div>';
    }
    function formatCurrency(v) {
      if (v === null || v === undefined || v === '') return null;
      var n = Number(v); if (!Number.isFinite(n)) return v;
      return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    function showPopup(item, marker) {
      var color = getDestinationColor(item.destinacao);
      var html = '<div class="mapPopupCard"><h4>' + escapeHtml(item.titulo || 'Registro') + '</h4>' +
        (item.status ? '<div style="margin-bottom:8px"><span class="mapStatusBadge" style="background:' + color + '22; color:' + color + '"><span class="mapStatDot" style="background:' + color + '"></span>' + escapeHtml(item.status) + '</span></div>' : '') +
        rowHtml('Municipio', item.municipio) + rowHtml('Modalidade', item.modalidade) + rowHtml('Destinacao', item.destinacao) +
        rowHtml('Layer', item.layer) + rowHtml('Situacao', item.situacao) + rowHtml('Construtora', item.construtora) + rowHtml('Gestor', item.gestor) +
        rowHtml('Valor', formatCurrency(item.valor)) + rowHtml('Execucao', item.percentual_execucao != null && item.percentual_execucao !== '' ? item.percentual_execucao + '%' : null) +
        rowHtml('Atualizado em', item.ultima_atualizacao) + '</div>';
      marker.bindPopup(html, { closeButton: true, maxWidth: 280 }).openPopup();
    }

    /* ---------------- Filtros (apenas Name, Destinacao e Layer) ---------------- */
    function collectFilterParams() {
      var params = {};
      if ($('mapFilterName').value) params.name = $('mapFilterName').value;
      if ($('mapFilterDestinacao').value) params.destinacao = $('mapFilterDestinacao').value;
      if ($('mapFilterLayer').value) params.layer = $('mapFilterLayer').value;
      return params;
    }

    function setState(kind, msg) {
      hideEl('mapLoadingState'); hideEl('mapErrorState'); hideEl('mapEmptyState');
      if (kind === 'loading') showEl('mapLoadingState');
      else if (kind === 'error') { $('mapErrorMsg').textContent = msg || 'Nao foi possivel carregar o mapa.'; showEl('mapErrorState'); }
      else if (kind === 'empty') showEl('mapEmptyState');
    }

    function loadData() {
      setState('loading');
      if (abortController) abortController.abort();
      abortController = new AbortController();
      var params = collectFilterParams();
      console.log('[map] Requisitando dados da API /api/mapa com filtros:', params);
      var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
      fetch('/api/mapa' + (qs ? '?' + qs : ''), { credentials: 'same-origin', signal: abortController.signal })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) { var err = new Error(data.error || ('Erro HTTP ' + r.status + ' ao carregar o mapa')); err.status = r.status; err.data = data; throw err; }
            return data;
          });
        })
        .then(function (data) {
          lastItems = data.items || [];
          console.log('[map] ' + lastItems.length + ' registro(s) recebido(s) da API.');
          renderPolygonsFromCache();
          renderStats(lastItems);
          renderLegend(lastItems);
          setState(lastItems.length ? 'ok' : 'empty');
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') { console.log('[map] Requisicao anterior abortada (nova requisicao em andamento).'); return; }
          console.error('[map] Falha ao carregar dados do mapa:', err);
          if (err && err.data && err.data.needsConfig) { toast('A fonte configurada nao e mais valida. Escolha novamente.', 'error'); backToSelect(); return; }
          setState('error', getErrorMessage(err));
        });
    }

    function renderStats(items) {
      var counts = {};
      items.forEach(function (it) { var k = it.status || 'Sem status'; counts[k] = (counts[k] || 0) + 1; });
      var html = '<div class="mapStatChip"><div class="val">' + items.length + '</div><div class="lbl">Total</div></div>';
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7).forEach(function (k) {
        html += '<div class="mapStatChip"><div class="val">' + counts[k] + '</div><div class="lbl"><span class="mapStatDot" style="background:' + getDestinationColor(k) + '"></span>' + escapeHtml(k) + '</div></div>';
      });
      $('mapStatsGrid').innerHTML = html;
    }

    function renderLegend(items) {
      // Legenda construida dinamicamente a partir das DESTINACOES presentes
      // nos dados carregados, usando exatamente a mesma funcao de cor dos
      // poligonos (getDestinationColor) -- garante que a cor de cada linha
      // da legenda seja sempre identica a cor do poligono correspondente.
      var seen = {};
      items.forEach(function (it) { if (it.destinacao) seen[it.destinacao] = true; });
      var keys = Object.keys(seen).sort();
      var html = '<strong style="font-size:11px">Legenda &middot; Destinacao</strong>';
      if (!keys.length) html += '<div class="small" style="margin-top:4px">Sem dados de destinacao</div>';
      keys.forEach(function (k) { html += '<div class="legendRow"><span class="legendDot" style="background:' + getDestinationColor(k) + '"></span>' + escapeHtml(k) + '</div>'; });
      $('mapLegend').innerHTML = html;
    }

    function fillSelect(id, values) {
      if (!values || !values.length) return;
      var el = $(id), current = el.value;
      el.innerHTML = '<option value="">Todas</option>' + values.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }).join('');
      el.value = current;
    }
    function loadFilterOptions() {
      console.log('[map] Carregando opcoes de filtro (destinacao, layer)...');
      api('GET', '/api/mapa/filtros').then(function (data) {
        fillSelect('mapFilterDestinacao', data.destinacao);
        fillSelect('mapFilterLayer', data.layer);
        console.log('[map] Opcoes de filtro carregadas com sucesso.');
      }).catch(function (err) {
        console.warn('[map] Falha ao carregar opcoes de filtro (nao critico, segue sem elas):', getErrorMessage(err));
      });
    }

    function wireFilters() {
      $('mapFilterName').addEventListener('input', debounce(function () {
        console.log('[map] Filtro "Name" alterado.');
        loadData();
      }, 450));
      ['mapFilterDestinacao', 'mapFilterLayer'].forEach(function (id) {
        $(id).addEventListener('change', function () {
          console.log('[map] Filtro alterado:', id, '=', $(id).value);
          loadData();
        });
      });
      $('mapClearFiltersBtn').addEventListener('click', function () {
        console.log('[map] Limpando todos os filtros.');
        $('mapFilterName').value = '';
        $('mapFilterDestinacao').value = '';
        $('mapFilterLayer').value = '';
        loadData();
      });
      /* "Tentar novamente": por design, executa APENAS o recarregamento dos
       * dados (loadData) -- nunca reinicializa o L.map(). Reinicializar o
       * mapa aqui e o que causava "Map container is already initialized" a
       * cada novo clique. Se o mapa nunca chegou a ser criado (falha grave
       * na inicializacao), orientamos o usuario a reabrir o painel em vez de
       * tentar recriar o mapa por baixo dos panos. */
      $('mapRetryBtn').addEventListener('click', retryLoadData);
    }

    function retryLoadData() {
      console.log('[map] Botao "Tentar novamente" clicado - recarregando apenas os dados (mapa nao e reinicializado).');
      if (!map) {
        var msg = 'O mapa ainda nao foi inicializado. Volte e selecione novamente a tabela/coluna de localizacao.';
        console.error('[map] ' + msg);
        setState('error', msg);
        return;
      }
      loadData();
    }

    function fitToData() {
      if (!lastItems.length || !map) return;
      var bounds = L.latLngBounds(lastItems.map(function (it) { return [it.latitude, it.longitude]; }));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
    }

    function wireControls() {
      $('mapZoomInBtn').addEventListener('click', function () { map.zoomIn(); });
      $('mapZoomOutBtn').addEventListener('click', function () { map.zoomOut(); });
      $('mapResetBtn').addEventListener('click', fitToData);
      $('mapFullscreenBtn').addEventListener('click', function () {
        var el = document.querySelector('#mapView .mapMain');
        if (!document.fullscreenElement) { if (el.requestFullscreen) el.requestFullscreen(); }
        else if (document.exitFullscreen) document.exitFullscreen();
      });
      $('mapLocateBtn').addEventListener('click', function () {
        if (!navigator.geolocation) { toast('Geolocalizacao nao suportada neste navegador.', 'error'); return; }
        navigator.geolocation.getCurrentPosition(function (pos) {
          map.flyTo([pos.coords.latitude, pos.coords.longitude], 13);
        }, function (err) { console.warn('[map] Falha ao obter geolocalizacao:', err); toast('Nao foi possivel obter sua localizacao.', 'error'); });
      });
      $('mapChangeSourceBtn').addEventListener('click', backToSelect);
      $('mapGeocodeInput').addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var q = this.value.trim(); if (!q) return;
        console.log('[map] Buscando endereco via Nominatim:', q);
        fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (results) {
            if (!results.length) { toast('Endereco nao encontrado.', 'error'); return; }
            map.flyTo([parseFloat(results[0].lat), parseFloat(results[0].lon)], 14);
          }).catch(function (err) { console.warn('[map] Falha ao buscar endereco (Nominatim indisponivel?):', err); toast('Falha ao buscar endereco.', 'error'); });
      });
    }

    return { enter: enter };
  })();

  /* ==================== INICIALIZACAO ==================== */
  MapModule.enter();
})();
</script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML_PAGE);
});

/* ### REGIAO: TRATAMENTO DE ERROS GLOBAL ### */
app.use((req, res) => {
  res.status(404).json({ error: "Rota nao encontrada." });
});

app.use((err, req, res, next) => {
  logEvent("error", "http", "Erro nao tratado", {
    error: err.message,
    stack: err.stack,
  });
  res
    .status(err.httpStatus || 500)
    .json({ error: "Erro interno do servidor." });
});

/* ### REGIAO: INICIALIZACAO DO SERVIDOR ### */
async function start() {
  try {
    await pool.query("SELECT 1;");
    logEvent("info", "boot", "Conexao com PostgreSQL verificada com sucesso.");
    await ensureSystemTables();
  } catch (err) {
    logEvent(
      "error",
      "boot",
      "Falha ao conectar ao PostgreSQL na inicializacao: " + err.message,
    );
    process.exit(1);
  }

  app.listen(CONFIG.PORT, () => {
    logEvent("info", "boot", "Servidor iniciado na porta " + CONFIG.PORT);
  });
}

process.on("unhandledRejection", (reason) => {
  logEvent("error", "process", "Unhandled Rejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  logEvent("error", "process", "Uncaught Exception", { error: err.message });
});

start();